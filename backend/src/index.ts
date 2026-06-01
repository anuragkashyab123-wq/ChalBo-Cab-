/**
 * ChalBo Cab - Main Application Entry Point
 * Sets up Express server with middleware, routes, and Socket.IO
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import winston from 'winston';

// Load environment variables
dotenv.config();

// Initialize Express app
const app: Express = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  },
});

// Configure Winston Logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Health Check Route
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/v1/auth', require('./routes/auth.routes'));
app.use('/api/v1/customers', require('./routes/customer.routes'));
app.use('/api/v1/drivers', require('./routes/driver.routes'));
app.use('/api/v1/bookings', require('./routes/booking.routes'));
app.use('/api/v1/vehicles', require('./routes/vehicle.routes'));
app.use('/api/v1/payments', require('./routes/payment.routes'));
app.use('/api/v1/wallet', require('./routes/wallet.routes'));
app.use('/api/v1/admin', require('./routes/admin.routes'));

// Swagger Documentation Route
app.get('/api-docs', (req: Request, res: Response) => {
  res.json({ message: 'API Documentation', version: '1.0.0' });
});

// Socket.IO Event Handlers
io.on('connection', (socket) => {
  logger.info(`User connected: ${socket.id}`);

  // Location Tracking
  socket.on('location-update', (data) => {
    socket.broadcast.emit('location-update', {
      userId: data.userId,
      latitude: data.latitude,
      longitude: data.longitude,
      timestamp: new Date().toISOString(),
    });
  });

  // Chat Messages
  socket.on('send-message', (data) => {
    socket.broadcast.emit('receive-message', {
      senderId: data.senderId,
      message: data.message,
      timestamp: new Date().toISOString(),
    });
  });

  // Trip Status Updates
  socket.on('trip-status', (data) => {
    socket.broadcast.emit('trip-status-update', {
      tripId: data.tripId,
      status: data.status,
      timestamp: new Date().toISOString(),
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    logger.info(`User disconnected: ${socket.id}`);
  });
});

// Error Handling Middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error(err.message);
  res.status(500).json({
    success: false,
    status: 500,
    message: err.message || 'Internal Server Error',
  });
});

// 404 Handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    status: 404,
    message: 'Route not found',
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  logger.info(`ChalBo Cab Backend running on port ${PORT}`);
  console.log(`🚀 Server started on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

export { app, io, logger };
