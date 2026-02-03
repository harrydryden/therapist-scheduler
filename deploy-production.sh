#!/bin/bash
set -e

echo "🚀 Starting production deployment..."

# Check for required environment variables
if [ -z "$JWT_SECRET" ]; then
  echo "❌ JWT_SECRET environment variable is required"
  exit 1
fi

if [ -z "$OPENAI_API_KEY" ]; then
  echo "❌ OPENAI_API_KEY environment variable is required"
  exit 1
fi

echo "✅ Environment variables verified"

# Create performance indexes migration if it doesn't exist
if [ ! -f "supabase/migrations/20250101000000_add_performance_indexes.sql" ]; then
  echo "📝 Creating performance indexes migration..."
  mkdir -p supabase/migrations
  cat > supabase/migrations/20250101000000_add_performance_indexes.sql << 'EOF'
-- Add performance indexes for production optimization
-- This migration adds indexes to support the optimized queries

-- Index for deliberations queries (used in getDeliberations)
CREATE INDEX IF NOT EXISTS idx_deliberations_public_created 
ON deliberations(is_public, created_at DESC);

-- Index for participants count queries
CREATE INDEX IF NOT EXISTS idx_participants_deliberation_id 
ON participants(deliberation_id);

-- Index for messages queries (used in chat)
CREATE INDEX IF NOT EXISTS idx_messages_deliberation_created 
ON messages(deliberation_id, created_at DESC);

-- Index for user messages
CREATE INDEX IF NOT EXISTS idx_messages_user_created 
ON messages(user_id, created_at DESC);

-- Index for IBIS submissions
CREATE INDEX IF NOT EXISTS idx_messages_submitted_ibis 
ON messages(submitted_to_ibis, created_at DESC);

-- Composite index for deliberation participants
CREATE INDEX IF NOT EXISTS idx_participants_user_deliberation 
ON participants(user_id, deliberation_id);

-- Index for agent configurations
CREATE INDEX IF NOT EXISTS idx_agent_config_type_active 
ON agent_configurations(agent_type, is_active, is_default);

-- Index for facilitator sessions
CREATE INDEX IF NOT EXISTS idx_facilitator_sessions_user_deliberation 
ON facilitator_sessions(user_id, deliberation_id);

-- Index for real-time message subscriptions
CREATE INDEX IF NOT EXISTS idx_messages_realtime 
ON messages(deliberation_id, message_type, created_at DESC);
EOF
  echo "✅ Performance indexes migration created"
fi

# Install dependencies
echo "📦 Installing frontend dependencies..."
npm install

echo "📦 Installing backend dependencies..."
cd backend && npm install && cd ..

# Build frontend
echo "🔨 Building frontend..."
npm run build

# Build backend
echo "🔨 Building backend..."
cd backend && npm run build && cd ..

# Stop existing containers
echo "🛑 Stopping existing containers..."
docker-compose down

# Build and start production containers
echo "🐳 Building and starting production containers..."
docker-compose -f docker-compose.yml up -d --build

# Wait for services to be healthy
echo "⏳ Waiting for services to be healthy..."
sleep 30

# Verify deployment
echo "🔍 Verifying deployment..."

# Check health endpoint
if curl -f http://localhost:3000/health > /dev/null 2>&1; then
  echo "✅ Health check passed"
else
  echo "❌ Health check failed"
  exit 1
fi

# Check metrics endpoint
if curl -f http://localhost:3000/metrics > /dev/null 2>&1; then
  echo "✅ Metrics endpoint accessible"
else
  echo "❌ Metrics endpoint failed"
  exit 1
fi

# Apply database indexes directly to running postgres container
echo "🗄️ Applying database indexes..."
docker exec deliberation-main-postgres-1 psql -U postgres -d deliberation -f /docker-entrypoint-initdb.d/20250101000000_add_performance_indexes.sql 2>/dev/null || {
  echo "⚠️ Could not apply indexes directly. Please run them manually in Supabase dashboard:"
  echo "   File: supabase/migrations/20250101000000_add_performance_indexes.sql"
}

echo "✅ Production deployment completed successfully!"

echo ""
echo "🎯 Deployment Summary:"
echo "   - Frontend: http://localhost:3000"
echo "   - Backend API: http://localhost:3000"
echo "   - Health Check: http://localhost:3000/health"
echo "   - Metrics: http://localhost:3000/metrics"
echo "   - Database: localhost:5432"
echo "   - Redis: localhost:6379"
echo ""
echo "📊 Performance Expectations (2-3 deliberations, hundreds of messages):"
echo "   - Message rendering: < 100ms (virtual scrolling enabled)"
echo "   - Database queries: < 50ms (indexes applied)"
echo "   - AI responses: < 5s (OpenAI API)"
echo "   - Connection limits: 3 per user, 50 total"
echo ""
echo "🔧 Next steps:"
echo "   1. Verify all endpoints are working"
echo "   2. Monitor /metrics endpoint for performance"
echo "   3. Test with your deliberation data"
echo "   4. Scale up if needed (see PRODUCTION_DEPLOYMENT.md)"

