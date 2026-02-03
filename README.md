# Democratic Deliberation Platform

A modern, AI-powered platform for facilitating democratic deliberations with real-time collaboration, intelligent moderation, and structured decision-making processes.

## ✨ **Features**

- **Real-time Chat**: Live messaging with WebSocket support
- **AI Integration**: Direct OpenAI API integration
- **IBIS Mapping**: Structured argument mapping and visualization
- **Multi-backend Support**: Supabase and Node.js backends
- **Performance Optimized**: Virtual scrolling, connection management, monitoring
- **Production Ready**: Docker deployment, health checks, metrics

## 🚀 **Quick Start**

### **Prerequisites**
- Node.js 18+
- Docker & Docker Compose
- OpenAI API key
- PostgreSQL database

### **Environment Setup**
```bash
# Copy environment template
cp .env.example .env

# Configure required variables
OPENAI_API_KEY=your-openai-api-key-here
JWT_SECRET=your-secure-jwt-secret
DATABASE_URL=postgresql://user:pass@host:5432/db
REDIS_URL=redis://host:6379
```

### **Development**
```bash
# Install dependencies
npm install
cd backend && npm install && cd ..

# Start development environment
docker-compose -f docker-compose.dev.yml up -d

# Start frontend dev server
npm run dev
```

### **Production Deployment**
```bash
# Set environment variables
export JWT_SECRET="your-secure-secret"
export OPENAI_API_KEY="your-openai-key"
export DATABASE_URL="postgresql://user:pass@host:5432/db"
export REDIS_URL="redis://host:6379"

# Run deployment script
./deploy-production.sh
```

## 🏗️ **Architecture**

### **Frontend**
- **React 18** with TypeScript
- **Vite** for fast development and optimized builds
- **Shadcn UI** components
- **React Router** for navigation
- **Virtual scrolling** for performance

### **Backend Options**
- **Node.js/Fastify**: Full-featured backend with AI orchestration
- **Supabase**: Serverless backend with real-time features

### **AI Services**
- **OpenAI API**: GPT-4 for intelligent responses and moderation
- **Content Safety**: Automated content filtering
- **Message Classification**: Intelligent categorization

### **Performance Features**
- **Database Indexing**: Optimized queries for large datasets
- **Connection Management**: Resource limits and cleanup
- **Real-time Monitoring**: Performance metrics and health checks
- **Caching**: Redis-based response caching

## 📊 **Performance Expectations**

### **Small Scale (2-3 deliberations)**
- **Message Rendering**: < 100ms (virtual scrolling)
- **Database Queries**: < 50ms (with indexes)
- **AI Responses**: < 5s (OpenAI API)
- **Connection Limits**: 3 per user, 50 total

### **Scaling Up**
- **Medium**: 10+ deliberations, 500+ messages
- **Large**: 50+ deliberations, 1000+ messages
- **Enterprise**: 100+ deliberations, 5000+ messages

## 🔧 **Configuration**

### **Environment Variables**
```bash
# AI Configuration
OPENAI_API_KEY=your-openai-api-key

# Security
JWT_SECRET=your-secure-jwt-secret

# Database
DATABASE_URL=postgresql://user:pass@host:5432/db

# Redis
REDIS_URL=redis://host:6379

# Performance Tuning
RATE_LIMIT_MAX=200
SSE_MAX_CONNECTIONS=100
MAX_CONNECTIONS_PER_USER=3
MAX_TOTAL_CONNECTIONS=50
```

### **Docker Configuration**
- **Resource Limits**: CPU and memory constraints
- **Health Checks**: Automated service monitoring
- **Auto-restart**: Service recovery on failure
- **Volume Persistence**: Data and configuration persistence

## 📈 **Monitoring & Observability**

### **Health Endpoints**
- **Health Check**: `GET /health`
- **Performance Metrics**: `GET /metrics`

### **Key Metrics**
- Message processing time
- Database query performance
- AI response latency
- Active connections
- Error rates
- Cache hit rates

### **Logging**
- Structured logging with Pino
- Performance monitoring
- Error tracking
- Request tracing

## 🚨 **Troubleshooting**

### **Common Issues**
1. **High Memory Usage**: Check Docker resource limits
2. **Slow AI Responses**: Verify OpenAI API quota and status
3. **Database Performance**: Ensure indexes are applied
4. **Connection Issues**: Check rate limiting and connection limits

### **Debug Commands**
```bash
# Check service status
docker-compose ps

# View logs
docker-compose logs -f app

# Check metrics
curl http://localhost:3000/metrics

# Verify health
curl http://localhost:3000/health
```

## 📚 **Documentation**

- **Production Deployment**: See `PRODUCTION_DEPLOYMENT.md`
- **API Reference**: Backend API documentation
- **Performance Guide**: Optimization and scaling strategies
- **Troubleshooting**: Common issues and solutions

## 🤝 **Contributing**

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 **License**

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 **Support**

For support and questions:
1. Check the troubleshooting section
2. Review the documentation
3. Open an issue on GitHub
4. Check performance metrics and logs

---

**Built for democratic deliberation at scale** 🗳️✨

