/**
 * Payment Routes
 * Handles payment processing, refunds, and transaction management
 */

import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import crypto from 'crypto';

const router = Router();
const prisma = new PrismaClient();

const verifyToken = (req: any, res: Response, next: Function) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  req.userId = 'user-id';
  next();
};

/**
 * POST /api/v1/payments/create-order
 * Create Razorpay order
 */
router.post(
  '/create-order',
  verifyToken,
  [
    body('bookingId').notEmpty(),
    body('amount').isFloat({ min: 1 }),
    body('currency').optional().isIn(['INR', 'USD']),
  ],
  async (req: any, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { bookingId, amount, currency = 'INR' } = req.body;

      // Create Razorpay order
      const orderResponse = await axios.post(
        'https://api.razorpay.com/v1/orders',
        {
          amount: Math.round(amount * 100), // Convert to paise
          currency,
          receipt: bookingId,
        },
        {
          auth: {
            username: process.env.RAZORPAY_KEY_ID || '',
            password: process.env.RAZORPAY_KEY_SECRET || '',
          },
        }
      );

      const order = orderResponse.data;

      // Save payment record
      const payment = await prisma.payment.create({
        data: {
          bookingId,
          amount: parseFloat(amount),
          paymentMethod: 'RAZORPAY',
          paymentGateway: 'RAZORPAY',
          transactionId: order.id,
          status: 'PENDING',
        },
      });

      res.json({
        success: true,
        message: 'Order created successfully',
        data: {
          orderId: order.id,
          amount: order.amount / 100,
          currency: order.currency,
          key: process.env.RAZORPAY_KEY_ID,
          paymentId: payment.id,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * POST /api/v1/payments/verify
 * Verify payment signature from Razorpay
 */
router.post(
  '/verify',
  [
    body('razorpay_order_id').notEmpty(),
    body('razorpay_payment_id').notEmpty(),
    body('razorpay_signature').notEmpty(),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

      // Verify signature
      const message = razorpay_order_id + '|' + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
        .update(message)
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({
          success: false,
          message: 'Invalid payment signature',
        });
      }

      // Find and update payment
      const payment = await prisma.payment.findUnique({
        where: { transactionId: razorpay_order_id },
      });

      if (!payment) {
        return res.status(404).json({
          success: false,
          message: 'Payment not found',
        });
      }

      // Update payment status
      const updatedPayment = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'SUCCESS',
        },
      });

      // Update booking payment status
      await prisma.booking.update({
        where: { id: payment.bookingId },
        data: {
          paymentStatus: 'COMPLETED',
        },
      });

      // Create wallet transaction if using wallet
      const booking = await prisma.booking.findUnique({
        where: { id: payment.bookingId },
      });

      if (booking?.paymentMethod === 'WALLET') {
        const wallet = await prisma.wallet.findUnique({
          where: { userId: booking.customerId },
        });

        if (wallet) {
          const newBalance = parseFloat(wallet.balance.toString()) - payment.amount;

          await prisma.wallet.update({
            where: { id: wallet.id },
            data: { balance: newBalance },
          });

          await prisma.transaction.create({
            data: {
              walletId: wallet.id,
              type: 'DEBIT',
              amount: payment.amount,
              description: `Payment for booking ${booking.bookingNumber}`,
              relatedTo: 'BOOKING',
              relatedId: booking.id,
              balanceBefore: parseFloat(wallet.balance.toString()),
              balanceAfter: newBalance,
            },
          });
        }
      }

      res.json({
        success: true,
        message: 'Payment verified successfully',
        data: {
          paymentId: updatedPayment.id,
          status: updatedPayment.status,
          amount: updatedPayment.amount,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * POST /api/v1/payments/:paymentId/refund
 * Process refund for a payment
 */
router.post(
  '/:paymentId/refund',
  verifyToken,
  [body('reason').notEmpty()],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { paymentId } = req.params;
      const { reason } = req.body;

      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });

      if (!payment) {
        return res.status(404).json({
          success: false,
          message: 'Payment not found',
        });
      }

      if (payment.status !== 'SUCCESS') {
        return res.status(400).json({
          success: false,
          message: 'Can only refund completed payments',
        });
      }

      // Create refund in Razorpay
      const refundResponse = await axios.post(
        `https://api.razorpay.com/v1/payments/${payment.transactionId}/refund`,
        {
          amount: Math.round(payment.amount * 100),
          notes: { reason },
        },
        {
          auth: {
            username: process.env.RAZORPAY_KEY_ID || '',
            password: process.env.RAZORPAY_KEY_SECRET || '',
          },
        }
      );

      const refund = refundResponse.data;

      // Update payment record
      const updatedPayment = await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: 'REFUNDED',
          refundAmount: payment.amount,
          refundReason: reason,
          refundTransactionId: refund.id,
        },
      });

      res.json({
        success: true,
        message: 'Refund processed successfully',
        data: {
          refundId: refund.id,
          amount: refund.amount / 100,
          status: refund.status,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * GET /api/v1/payments/:bookingId
 * Get payment details
 */
router.get('/:bookingId', verifyToken, async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;

    const payment = await prisma.payment.findUnique({
      where: { bookingId },
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
      });
    }

    res.json({
      success: true,
      data: payment,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/v1/payments
 * Get payment history
 */
router.get(
  '/',
  verifyToken,
  async (req: any, res: Response) => {
    try {
      const { status, limit = 10, offset = 0 } = req.query;

      const where: any = {};
      if (status) {
        where.status = status;
      }

      const payments = await prisma.payment.findMany({
        where,
        include: {
          booking: true,
        },
        take: parseInt(limit),
        skip: parseInt(offset),
        orderBy: { createdAt: 'desc' },
      });

      const total = await prisma.payment.count({ where });

      res.json({
        success: true,
        data: payments,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * POST /api/v1/payments/invoice/:bookingId
 * Generate invoice for booking
 */
router.post(
  '/invoice/:bookingId',
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const { bookingId } = req.params;

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          payment: true,
          customer: {
            include: {
              user: true,
            },
          },
        },
      });

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found',
        });
      }

      if (!booking.payment) {
        return res.status(400).json({
          success: false,
          message: 'No payment found for this booking',
        });
      }

      // Generate invoice data
      const invoice = {
        invoiceNumber: `INV-${booking.bookingNumber}`,
        date: new Date().toISOString().split('T')[0],
        customer: {
          name: `${booking.customer.user.firstName} ${booking.customer.user.lastName}`,
          email: booking.customer.user.email,
          phone: booking.customer.user.phoneNumber,
        },
        booking: {
          bookingNumber: booking.bookingNumber,
          from: booking.pickupAddress,
          to: booking.dropAddress,
          distance: booking.actualDistance || booking.estimatedDistance,
          duration: booking.actualDuration || booking.estimatedDuration,
        },
        payment: {
          fare: booking.actualFare || booking.estimatedFare,
          discount: booking.discountAmount,
          tax: booking.taxAmount,
          total: booking.totalAmount,
          method: booking.paymentMethod,
        },
      };

      res.json({
        success: true,
        message: 'Invoice generated',
        data: invoice,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

export default router;
