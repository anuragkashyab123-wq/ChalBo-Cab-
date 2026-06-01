/**
 * Booking Routes
 * Handles trip booking creation, management, and status updates
 */

import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const router = Router();
const prisma = new PrismaClient();

// Middleware to verify JWT token
const verifyToken = (req: any, res: Response, next: Function) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  // Verify token logic here
  req.userId = 'user-id'; // Mock for demo
  next();
};

/**
 * POST /api/v1/bookings
 * Create a new booking
 */
router.post(
  '/',
  verifyToken,
  [
    body('pickupLatitude').isFloat(),
    body('pickupLongitude').isFloat(),
    body('pickupAddress').notEmpty(),
    body('dropLatitude').isFloat(),
    body('dropLongitude').isFloat(),
    body('dropAddress').notEmpty(),
    body('bookingType').isIn(['ONE_WAY', 'ROUND_TRIP', 'MULTI_CITY', 'AIRPORT_TRANSFER']),
    body('vehicleCategory').isIn(['ECONOMY', 'COMFORT', 'PREMIUM', 'SUV', 'VAN']),
  ],
  async (req: any, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const {
        pickupLatitude,
        pickupLongitude,
        pickupAddress,
        dropLatitude,
        dropLongitude,
        dropAddress,
        bookingType,
        vehicleCategory,
        bookingDateTime,
        paymentMethod,
      } = req.body;

      // Calculate distance using Google Maps API
      const distanceResponse = await axios.get(
        'https://maps.googleapis.com/maps/api/distancematrix/json',
        {
          params: {
            origins: `${pickupLatitude},${pickupLongitude}`,
            destinations: `${dropLatitude},${dropLongitude}`,
            key: process.env.GOOGLE_MAPS_API_KEY,
          },
        }
      );

      const distance =
        distanceResponse.data.rows[0].elements[0].distance.value / 1000; // Convert to km
      const duration =
        distanceResponse.data.rows[0].elements[0].duration.value / 60; // Convert to minutes

      // Calculate fare (Base fare + per km charge)
      const baseFare = 100;
      const perKmCharge = 15;
      const estimatedFare = baseFare + distance * perKmCharge;

      // Generate booking number
      const bookingNumber = `CB${Date.now()}`;

      // Create booking
      const booking = await prisma.booking.create({
        data: {
          bookingNumber,
          customerId: req.userId,
          pickupLatitude: parseFloat(pickupLatitude),
          pickupLongitude: parseFloat(pickupLongitude),
          pickupAddress,
          dropLatitude: parseFloat(dropLatitude),
          dropLongitude: parseFloat(dropLongitude),
          dropAddress,
          bookingType,
          vehicleCategory,
          status: 'PENDING',
          bookingDateTime: new Date(bookingDateTime),
          estimatedDistance: distance,
          estimatedDuration: Math.round(duration),
          estimatedFare,
          paymentMethod,
          totalAmount: estimatedFare,
        },
      });

      res.status(201).json({
        success: true,
        message: 'Booking created successfully',
        data: {
          bookingId: booking.id,
          bookingNumber: booking.bookingNumber,
          status: booking.status,
          estimatedFare: booking.estimatedFare,
          estimatedDistance: booking.estimatedDistance,
          estimatedDuration: booking.estimatedDuration,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * GET /api/v1/bookings/:bookingId
 * Get booking details
 */
router.get('/:bookingId', verifyToken, async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        customer: true,
        payment: true,
        trip: true,
        reviews: true,
      },
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
      });
    }

    res.json({
      success: true,
      data: booking,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/v1/bookings
 * Get all bookings for a customer
 */
router.get('/', verifyToken, async (req: any, res: Response) => {
  try {
    const { status, limit = 10, offset = 0 } = req.query;

    const where: any = { customerId: req.userId };
    if (status) {
      where.status = status;
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        customer: true,
        trip: true,
        reviews: true,
      },
      take: parseInt(limit),
      skip: parseInt(offset),
      orderBy: { createdAt: 'desc' },
    });

    const total = await prisma.booking.count({ where });

    res.json({
      success: true,
      data: bookings,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /api/v1/bookings/:bookingId/cancel
 * Cancel a booking
 */
router.put(
  '/:bookingId/cancel',
  verifyToken,
  [body('reason').optional().isString()],
  async (req: Request, res: Response) => {
    try {
      const { bookingId } = req.params;
      const { reason } = req.body;

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found',
        });
      }

      if (booking.status === 'CANCELLED' || booking.status === 'COMPLETED') {
        return res.status(400).json({
          success: false,
          message: `Cannot cancel booking with status ${booking.status}`,
        });
      }

      // Update booking status
      const updatedBooking = await prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: 'CANCELLED',
        },
      });

      // Record status change
      await prisma.bookingStatusHistory.create({
        data: {
          bookingId,
          previousStatus: booking.status,
          newStatus: 'CANCELLED',
          reason,
        },
      });

      res.json({
        success: true,
        message: 'Booking cancelled successfully',
        data: updatedBooking,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * POST /api/v1/bookings/:bookingId/accept
 * Accept a booking (for driver)
 */
router.post('/:bookingId/accept', verifyToken, async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const { driverId, vehicleId } = req.body;

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
      });
    }

    if (booking.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: 'Booking cannot be accepted in current status',
      });
    }

    // Update booking status
    const updatedBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'ACCEPTED',
      },
    });

    // Create trip
    await prisma.trip.create({
      data: {
        bookingId,
        driverId,
        vehicleId,
        status: 'STARTED',
      },
    });

    // Record status change
    await prisma.bookingStatusHistory.create({
      data: {
        bookingId,
        previousStatus: booking.status,
        newStatus: 'ACCEPTED',
      },
    });

    res.json({
      success: true,
      message: 'Booking accepted successfully',
      data: updatedBooking,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /api/v1/bookings/:bookingId/rate
 * Rate a booking
 */
router.put(
  '/:bookingId/rate',
  verifyToken,
  [
    body('rating').isInt({ min: 1, max: 5 }),
    body('comment').optional().isString(),
  ],
  async (req: any, res: Response) => {
    try {
      const { bookingId } = req.params;
      const { rating, comment } = req.body;

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found',
        });
      }

      if (booking.status !== 'COMPLETED') {
        return res.status(400).json({
          success: false,
          message: 'Can only rate completed bookings',
        });
      }

      // Get trip to find driver/vehicle
      const trip = await prisma.trip.findUnique({
        where: { bookingId },
      });

      // Create review for driver
      await prisma.review.create({
        data: {
          bookingId,
          revieweeId: trip.driverId,
          reviewerId: booking.customerId,
          rating,
          comment,
        },
      });

      res.json({
        success: true,
        message: 'Review submitted successfully',
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

export default router;
