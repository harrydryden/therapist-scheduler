/**
 * Health check script for Docker HEALTHCHECK
 * Checks if the server is responding to /health endpoint
 *
 * NOTE: This is a standalone script that runs independently of the main application.
 * Using console.error is intentional - this script is invoked by Docker's HEALTHCHECK
 * and writes to stderr which Docker monitors. It doesn't have access to the application's
 * logger infrastructure, and structured logging is not needed for health check output.
 */

const http = require('http');

const PORT = process.env.PORT || 3000;

const options = {
  hostname: 'localhost',
  port: PORT,
  path: '/health',
  method: 'GET',
  timeout: 3000,
};

const req = http.request(options, (res: any) => {
  if (res.statusCode === 200) {
    process.exit(0);
  } else {
    console.error(`Health check failed with status: ${res.statusCode}`);
    process.exit(1);
  }
});

req.on('error', (err: Error) => {
  console.error(`Health check failed: ${err.message}`);
  process.exit(1);
});

req.on('timeout', () => {
  console.error('Health check timed out');
  req.destroy();
  process.exit(1);
});

req.end();
