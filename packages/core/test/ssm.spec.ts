/**
 * Tests for SSM parameter loading.
 */

describe('ssm', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.AWS_REGION = 'sa-east-1';
  });

  afterEach(() => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    jest.useRealTimers();
  });

  async function loadSsmModule(sendMock: jest.Mock) {
    jest.doMock('@aws-sdk/client-ssm', () => ({
      SSMClient: jest.fn().mockImplementation(() => ({
        send: sendMock,
      })),
      GetParameterCommand: class GetParameterCommand {
        constructor(public readonly input: unknown) {}
      },
    }));

    return import('../src/ssm');
  }

  it('returns undefined for ParameterNotFound without retrying', async () => {
    const sendMock = jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));
    const { getSsmParameter } = await loadSsmModule(sendMock);

    await expect(getSsmParameter('/test/missing')).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('retries throttling errors and eventually succeeds', async () => {
    jest.useFakeTimers();

    const sendMock = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .mockRejectedValueOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .mockResolvedValue({ Parameter: { Value: 'secret-value' } });

    const { getSsmParameter } = await loadSsmModule(sendMock);

    const promise = getSsmParameter('/test/throttled');
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe('secret-value');
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it('throws a typed error for non-not-found SSM failures', async () => {
    const sendMock = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('Access denied to parameter'), { name: 'AccessDeniedException' }));

    const { getSsmParameter, SsmParameterReadError } = await loadSsmModule(sendMock);

    const promise = getSsmParameter('/test/denied');

    await expect(promise).rejects.toBeInstanceOf(SsmParameterReadError);
    await expect(promise).rejects.toThrow('Access denied to parameter');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
