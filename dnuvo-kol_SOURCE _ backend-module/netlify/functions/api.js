const serverless = require('serverless-http');
const { app, ensureInitialized } = require('../../server');

const handler = serverless(app, {
  basePath: '/.netlify/functions/api',
});

exports.handler = async (event, context) => {
  await ensureInitialized();
  return handler(event, context);
};
