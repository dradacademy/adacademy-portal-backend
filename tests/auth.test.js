const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const userModel = require('../models/userModel');

// Mock dependencies
jest.mock('../models/userModel');
jest.mock('bcrypt');
jest.mock('jsonwebtoken');
jest.mock('../config/db', () => ({
  connectWithRetry: jest.fn(),
}));

// Import app AFTER mocking
const app = require('../index');

describe('Auth Endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/users/register', () => {
    it('should register a new user successfully', async () => {
      // Setup mocks
      userModel.findOne.mockResolvedValue(null); // No existing user
      bcrypt.genSalt.mockResolvedValue('salt');
      bcrypt.hash.mockResolvedValue('hashedPassword');
      userModel.create.mockResolvedValue({
        _id: '123',
        username: 'testu',
        email: 'test@example.com',
        role: 'evaluator',
      });

      const res = await request(app)
        .post('/api/users/register')
        .send({
          username: 'testu',
          email: 'test@example.com',
          password: 'password123',
          role: 'evaluator',
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body).toHaveProperty('user');
      expect(userModel.create).toHaveBeenCalled();
    });

    it('should return 400 if user/email already exists', async () => {
      userModel.findOne.mockResolvedValue({ email: 'existing@example.com' });

      const res = await request(app)
        .post('/api/users/register')
        .send({
            username: 'testu',
            email: 'existing@example.com',
            password: 'password123',
            role: 'evaluator',
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toMatch(/already exists/i);
    });
  });

  describe('POST /api/users/login', () => {
    it('should login successfully with correct credentials', async () => {
      const mockUser = {
        _id: '123',
        email: 'test@example.com',
        password: 'hashedPassword',
        role: 'evaluator',
        toObject: function() { return this; }
      };

      userModel.findOne.mockResolvedValue(mockUser);
      bcrypt.compare.mockResolvedValue(true);
      jwt.sign.mockReturnValue('mockToken');

      const res = await request(app)
        .post('/api/users/login')
        .send({
          email: 'test@example.com',
          password: 'password123',
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('token', 'mockToken');
    });

    it('should return 400 for invalid credentials', async () => {
      userModel.findOne.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/users/login')
        .send({
          email: 'wrong@example.com',
          password: 'password123',
        });

      expect(res.statusCode).toEqual(400);
    });
  });
});
