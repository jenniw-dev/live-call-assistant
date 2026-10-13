import { cancelAndThrowSafeStreamError } from '../src/api/stream-error.js';

async function main(): Promise<void> {
  const safeMessage = 'DeepSeek 回答逾時，請重試。';

  try {
    await cancelAndThrowSafeStreamError(
      { cancel: async () => { throw new Error('raw reader cancellation detail'); } },
      safeMessage,
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== safeMessage) {
      throw new Error('A cancellation failure replaced the safe SSE message.');
    }
    return;
  }

  throw new Error('Expected a safe SSE error.');
}

void main();
