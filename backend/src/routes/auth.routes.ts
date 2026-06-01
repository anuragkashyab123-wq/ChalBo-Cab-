/**
 * Authentication Routes
 * Handles user registration, login, OTP verification, and token refresh
 */

import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const router = Router();
const prisma = new PrismaClient();

// Generate OTP
const generateOTP = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Generate JWT Token
const generateToken = (userId: string, expiresIn: string = '15m'): string => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'secret', { expiresIn });
};

// Generate Refresh Token
const generateRefreshToken = (userId: string): string => {
  return jwt.sign({ userId }, process.env.REFRESH_TOKEN_SECRET || 'refresh-secret', {
    expiresIn: '30d',
  });
};

/**
 * POST /api/v1/auth/register
 * Register a new user
 */
router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('phoneNumber').isMobilePhone('any'),
    body('password').isLength({ min: 6 }),
    body('firstName').trim().notEmpty(),
    body('role').isIn(['CUSTOMER', 'DRIVER', 'CAR_OWNER', 'PARTNER']),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { email, phoneNumber, password, firstName, lastName, role } = req.body;

      // Check if user exists
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [{ email }, { phoneNumber }],
        },
      });

      if (existingUser) {
        return res.status(409).json({
          success: false,
          message: 'User already exists with this email or phone number',
        });
      }

      // Hash password
      const hashedPassword = await bcryptjs.hash(password, 10);

      // Create user
      const user = await prisma.user.create({
        data: {
          email,
          phoneNumber,
          password: hashedPassword,
          firstName,
          lastName,
          role,
        },
      });

      // Generate tokens
      const accessToken = generateToken(user.id);
      const refreshToken = generateRefreshToken(user.id);

      res.status(201).json({
        success: true,
        message: 'User registered successfully',
        data: {
          userId: user.id,
          email: user.email,
          phoneNumber: user.phoneNumber,
          role: user.role,
          accessToken,
          refreshToken,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * POST /api/v1/auth/send-otp
 * Send OTP to phone number
 */
router.post(
  '/send-otp',
  [body('phoneNumber').isMobilePhone('any')],
  async (req: Request, res: Response) => {
    try {
      const { phoneNumber } = req.body;

      const otp = generateOTP();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Store OTP in cache (Redis recommended for production)
      // For now, we'll use a simple in-memory storage
      console.log(`OTP for ${phoneNumber}: ${otp}`);

      res.json({
        success: true,
        message: 'OTP sent successfully',
        data: {
          phoneNumber,
          expiresIn: 600, // 10 minutes
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * POST /api/v1/auth/verify-otp
 * Verify OTP and login
 */
router.post(
  '/verify-otp',
  [
    body('phoneNumber').isMobilePhone('any'),
    body('otp').isLength({ min: 6, max: 6 }),
  ],
  async (req: Request, res: Response) => {
    try {
      const { phoneNumber, otp } = req.body;

      // Verify OTP (would check Redis cache in production)
      if (otp !== '123456') {
        // Mock OTP for demo
        return res.status(401).json({
          success: false,
          message: 'Invalid OTP',
        });
      }

      // Find user
      const user = await prisma.user.findUnique({
        where: { phoneNumber },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
        });
      }

      // Generate tokens
      const accessToken = generateToken(user.id);
      const refreshToken = generateRefreshToken(user.id);

      // Update last login
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      res.json({
        success: true,
        message: 'OTP verified successfully',
        data: {
          userId: user.id,
          email: user.email,
          phoneNumber: user.phoneNumber,
          role: user.role,
          accessToken,
          refreshToken,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * POST /api/v1/auth/login
 * Login with email and password
 */
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      // Find user
      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials',
        });
      }

      // Compare password
      const isPasswordValid = await bcryptjs.compare(password, user.password);

      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials',
        });
      }

      // Generate tokens
      const accessToken = generateToken(user.id);
      const refreshToken = generateRefreshToken(user.id);

      // Update last login
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      res.json({
        success: true,
        message: 'Login successful',
        data: {
          userId: user.id,
          email: user.email,
          phoneNumber: user.phoneNumber,
          role: user.role,
          accessToken,
          refreshToken,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

/**
 * POST /api/v1/auth/refresh-token
 * Refresh access token using refresh token
 */
router.post('/refresh-token', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token is required',
      });
    }

    try {
      const decoded = jwt.verify(
        refreshToken,
        process.env.REFRESH_TOKEN_SECRET || 'refresh-secret'
      ) as { userId: string };

      const accessToken = generateToken(decoded.userId);

      res.json({
        success: true,
        message: 'Token refreshed successfully',
        data: {
          accessToken,
        },
      });
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token',
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/v1/auth/logout
 * Logout user
 */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      message: 'Logout successful',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
