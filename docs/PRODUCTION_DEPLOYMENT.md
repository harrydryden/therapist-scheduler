# Production Deployment Guide

## 🎯 **Deployment Scale**

This guide is optimized for **small-scale production**:
- **2-3 deliberations** running simultaneously
- **Hundreds of messages** per deliberation
- **~100 IBIS contributions** per deliberation
- **10-50 concurrent users**

## 📋 **Pre-Deployment Checklist**

### **Environment Variables**
```bash
# Required
JWT_SECRET=<your-secure-jwt-secret>
OPENAI_API_KEY=<your-openai-api-key>
DATABASE_URL=<your-database-url>
REDIS_URL=<your-redis-url>

# Optional (with defaults)
RATE_LIMIT_MAX=200
SSE_MAX_CONNECTIONS=100
TOKEN_BUCKET_CAPACITY=200
TOKEN_BUCKET_REFILL_RATE=20
MAX_CONNECTIONS_PER_USER=3
MAX_TOTAL_CONNECTIONS=50
CONNECTION_TIMEOUT=300000
PERFORMANCE_MONITORING=true
```

### **Security Requirements**
- [ ] JWT_SECRET is cryptographically secure (32+ characters)
- [ ] OPENAI_API_KEY has sufficient quota for your expected usage
- [ ] Database and Redis connections are secure
- [ ] CORS is properly configured for your domain
- [ ] Rate limiting is enabled and configured

## 🐳 **Docker Deployment**

### **Quick Start**
```bash
# 1. Set environment variables
export JWT_SECRET="your-secure-secret"
export OPENAI_API_KEY="your-openai-key"
export DATABASE_URL="postgresql://user:pass@host:5432/db"
export REDIS_URL="redis://host:6379"

# 2. Run deployment script
./deploy-production.sh
```

### **Manual Deployment**
```bash
# Build and start
docker-compose -f docker-compose.yml up -d --build

# Check status
docker-compose ps

# View logs
docker-compose logs -f app
```

## 📊 **Performance Monitoring**

### **Key Metrics Endpoints**
- **Health Check**: `GET /health`
- **Performance Metrics**: `GET /metrics`

### **Expected Performance (Small Scale)**
- **Message Rendering**: < 100ms (virtual scrolling)
- **Database Queries**: < 50ms (with indexes)
- **AI Responses**: < 5s (OpenAI API)
- **Connection Limits**: 3 per user, 50 total

### **Monitoring Dashboard**
```bash
# Real-time metrics
curl http://localhost:3000/metrics | jq

# Health status
curl http://localhost:3000/health
```

## ⚙️ **Configuration Tuning**

### **Small Scale (Current)**
```yaml
rateLimitMax: 200
sseMaxConnections: 100
tokenBucketCapacity: 200
maxConnectionsPerUser: 3
maxTotalConnections: 50
```

### **Medium Scale (10+ deliberations)**
```yaml
rateLimitMax: 500
sseMaxConnections: 250
tokenBucketCapacity: 500
maxConnectionsPerUser: 5
maxTotalConnections: 150
```

### **Large Scale (50+ deliberations)**
```yaml
rateLimitMax: 1000
sseMaxConnections: 500
tokenBucketCapacity: 1000
maxConnectionsPerUser: 10
maxTotalConnections: 500
```

## 🚨 **Troubleshooting**

### **Common Issues**

#### **High Memory Usage**
```bash
# Check container resources
docker stats

# Restart with memory limits
docker-compose down
docker-compose up -d --build
```

#### **Slow AI Responses**
```bash
# Check OpenAI API status
curl -H "Authorization: Bearer $OPENAI_API_KEY" \
  https://api.openai.com/v1/models

# Monitor AI response times
curl http://localhost:3000/metrics | jq '.metrics.aiResponseTime'
```

#### **Database Performance**
```bash
# Check if indexes are applied
docker exec deliberation-main-postgres-1 psql -U postgres -d deliberation \
  -c "\d+ deliberations"

# Apply indexes manually if needed
docker exec deliberation-main-postgres-1 psql -U postgres -d deliberation \
  -f /docker-entrypoint-initdb.d/20250101000000_add_performance_indexes.sql
```

### **Log Analysis**
```bash
# Backend logs
docker-compose logs -f app

# Database logs
docker-compose logs -f postgres

# Redis logs
docker-compose logs -f redis
```

## 🔄 **Maintenance & Updates**

### **Regular Maintenance**
- **Daily**: Check health endpoints and metrics
- **Weekly**: Review performance metrics and logs
- **Monthly**: Update dependencies and security patches

### **Scaling Up**
1. **Increase connection limits** in docker-compose.yml
2. **Adjust rate limiting** based on usage patterns
3. **Monitor resource usage** and adjust Docker limits
4. **Consider load balancing** for multiple instances

### **Backup Strategy**
```bash
# Database backup
docker exec deliberation-main-postgres-1 pg_dump -U postgres deliberation > backup.sql

# Redis backup
docker exec deliberation-main-redis-1 redis-cli BGSAVE

# Configuration backup
cp docker-compose.yml docker-compose.yml.backup
cp .env .env.backup
```

## 📚 **Additional Resources**

- **Performance Monitoring**: See `/metrics` endpoint
- **Health Checks**: See `/health` endpoint
- **Logs**: Use `docker-compose logs`
- **Database**: Connect to PostgreSQL on port 5432
- **Cache**: Connect to Redis on port 6379

## 🆘 **Support**

For issues or questions:
1. Check the troubleshooting section above
2. Review logs: `docker-compose logs -f`
3. Check metrics: `curl http://localhost:3000/metrics`
4. Verify environment variables are set correctly
5. Ensure database indexes are applied

---

**Remember**: This system is optimized for small-scale production. Monitor performance and scale up gradually as your usage grows.

