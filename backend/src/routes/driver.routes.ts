/**
 * Driver Routes
 * Handles driver profile, documents, trips, and earnings
 */

import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import AWS from 'aws-sdk';

const router = Router();
const prisma = new PrismaClient();

// Configure AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// Configure multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

const verifyToken = (req: any, res: Response, next: Function) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  req.userId = 'driver-id';
  next();
};

/**
 * POST /api/v1/drivers/register
 * Register a new driver
 */
router.post(
  '/register',
  [
    body('licenseNumber').notEmpty(),
    body('licenseExpiry').isISO8601(),
    body('dateOfBirth').isISO8601(),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const {
        userId,
        licenseNumber,
        licenseExpiry,
        dateOfBirth,
        aadhaarNumber,
        panNumber,
      } = req.body;

      // Check if driver already exists
      const existingDriver = await prisma.driver.findFirst({
        where: {
          OR: [{ licenseNumber }, { aadhaarNumber }, { panNumber }],
        },
      });

      if (existingDriver) {
        return res.status(409).json({
          success: false,
          message: 'Driver with this license/Aadhaar/PAN already exists',
        });
      }

      // Create driver
      const driver = await prisma.driver.create({
        data: {
          userId,
          licenseNumber,
          licenseExpiry: new Date(licenseExpiry),
          dateOfBirth: new Date(dateOfBirth),
          aadhaarNumber,
          panNumber,
        },
      });

      res.status(201).json({
        success: true,
        message: 'Driver registered successfully',
        data: {
          driverId: driver.id,
          licenseNumber: driver.licenseNumber,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * POST /api/v1/drivers/:driverId/documents
 * Upload driver documents
 */
router.post(
  '/:driverId/documents',
  verifyToken,
  upload.single('document'),
  [body('documentType').isIn(['LICENSE', 'AADHAAR', 'PAN', 'PHOTO'])],
  async (req: any, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { driverId } = req.params;
      const { documentType, documentNumber, expiryDate } = req.body;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'Document file is required',
        });
      }

      // Upload to S3
      const fileName = `drivers/${driverId}/${documentType}-${Date.now()}.pdf`;
      const params = {
        Bucket: process.env.AWS_S3_BUCKET || 'chalbo-cab-bucket',
        Key: fileName,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      };

      const uploadResult = await s3.upload(params).promise();

      // Save document reference to database
      const document = await prisma.driverDocument.create({
        data: {
          driverId,
          documentType,
          documentNumber,
          expiryDate: expiryDate ? new Date(expiryDate) : undefined,
          documentUrl: uploadResult.Location,
        },
      });

      res.status(201).json({
        success: true,
        message: 'Document uploaded successfully',
        data: {
          documentId: document.id,
          documentUrl: document.documentUrl,
          status: 'PENDING_VERIFICATION',
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * GET /api/v1/drivers/:driverId
 * Get driver profile
 */
router.get('/:driverId', verifyToken, async (req: Request, res: Response) => {
  try {
    const { driverId } = req.params;

    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      include: {
        user: true,
        documents: true,
      },
    });

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
      });
    }

    res.json({
      success: true,
      data: driver,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /api/v1/drivers/:driverId/status
 * Update driver online/offline status
 */
router.put(
  '/:driverId/status',
  verifyToken,
  [body('isOnline').isBoolean()],
  async (req: Request, res: Response) => {
    try {
      const { driverId } = req.params;
      const { isOnline } = req.body;

      const driver = await prisma.driver.update({
        where: { id: driverId },
        data: {
          isOnline,
          isAcceptingRides: isOnline,
        },
      });

      res.json({
        success: true,
        message: 'Driver status updated',
        data: {
          driverId: driver.id,
          isOnline: driver.isOnline,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * PUT /api/v1/drivers/:driverId/location
 * Update driver real-time location
 */
router.put(
  '/:driverId/location',
  verifyToken,
  [
    body('latitude').isFloat(),
    body('longitude').isFloat(),
  ],
  async (req: Request, res: Response) => {
    try {
      const { driverId } = req.params;
      const { latitude, longitude } = req.body;

      const driver = await prisma.driver.update({
        where: { id: driverId },
        data: {
          currentLatitude: parseFloat(latitude),
          currentLongitude: parseFloat(longitude),
        },
      });

      res.json({
        success: true,
        message: 'Location updated',
        data: {
          driverId: driver.id,
          latitude: driver.currentLatitude,
          longitude: driver.currentLongitude,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * GET /api/v1/drivers/:driverId/earnings
 * Get driver earnings
 */
router.get('/:driverId/earnings', verifyToken, async (req: Request, res: Response) => {
  try {
    const { driverId } = req.params;
    const { from, to } = req.query;

    const whereCondition: any = { driverId };

    if (from && to) {
      whereCondition.earningDate = {
        gte: new Date(from as string),
        lte: new Date(to as string),
      };
    }

    const earnings = await prisma.earnings.findMany({
      where: whereCondition,
      orderBy: { earningDate: 'desc' },
    });

    const totalEarnings = earnings.reduce((sum, e) => sum + parseFloat(e.netEarning?.toString() || '0'), 0);
    const totalTrips = earnings.length;

    res.json({
      success: true,
      data: {
        earnings,
        totalEarnings,
        totalTrips,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/v1/drivers/:driverId/trips
 * Get driver trip history
 */
router.get('/:driverId/trips', verifyToken, async (req: Request, res: Response) => {
  try {
    const { driverId } = req.params;
    const { status, limit = 10, offset = 0 } = req.query;

    const where: any = { driverId };
    if (status) {
      where.status = status;
    }

    const trips = await prisma.trip.findMany({
      where,
      include: {
        booking: true,
        vehicle: true,
      },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
      orderBy: { createdAt: 'desc' },
    });

    const total = await prisma.trip.count({ where });

    res.json({
      success: true,
      data: trips,
      pagination: {
        total,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /api/v1/drivers/:driverId/bank-details
 * Update driver bank details
 */
router.put(
  '/:driverId/bank-details',
  verifyToken,
  [
    body('bankAccountNumber').notEmpty(),
    body('bankIFSC').notEmpty(),
    body('bankName').notEmpty(),
    body('accountHolderName').notEmpty(),
  ],
  async (req: Request, res: Response) => {
    try {
      const { driverId } = req.params;
      const { bankAccountNumber, bankIFSC, bankName, accountHolderName } = req.body;

      const driver = await prisma.driver.update({
        where: { id: driverId },
        data: {
          bankAccountNumber,
          bankIFSC,
          bankName,
          accountHolderName,
        },
      });

      res.json({
        success: true,
        message: 'Bank details updated',
        data: {
          driverId: driver.id,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

export default router;
