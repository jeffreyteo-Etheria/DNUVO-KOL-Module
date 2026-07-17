const serverless = require('serverless-http');
const { connectLambda } = require('@netlify/blobs');
const { app, ensureInitialized } = require('../../server');

const handler = serverless(app, {
  basePath: '/.netlify/functions/api',
});

exports.handler = async (event, context) => {
  // Wire Netlify Blobs for legacy-style functions so the SQLite repository
  // survives cold starts (must run before the DB initializes).
  try { connectLambda(event); } catch (_) {}
  await ensureInitialized();
  return handler(event, context);
};
