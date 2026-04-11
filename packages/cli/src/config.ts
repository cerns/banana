export const config = {
  token: process.env.BANANA_TOKEN ?? '',
  serverUrl: process.env.BANANA_SERVER_URL?.replace(/^ws/, 'http') ?? 'http://localhost:3000',
};

if (!config.token) {
  console.error('BANANA_TOKEN env var is required');
  process.exit(1);
}
