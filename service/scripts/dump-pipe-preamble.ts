process.env.DOTENV_CONFIG_QUIET = 'true';
const { generatePreamble } = await import('../src/preamble');
process.stdout.write(generatePreamble({
  callbackUrl: 'http://unused.invalid', callbackToken: 'pipe-test-token',
  executionId: 'pipe-test-execution', tools: [],
}));
