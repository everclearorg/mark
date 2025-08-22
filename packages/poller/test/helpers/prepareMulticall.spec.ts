import { prepareMulticall } from '../../src/helpers/multicall';
import sinon from 'sinon';
import { multicallAbi } from '../../src/helpers/contracts';
import { encodeFunctionData } from 'viem';
import { MarkConfiguration } from '@mark/core';

describe('Multicall Helper Functions', () => {
  describe('prepareMulticall', () => {
    const MOCK_MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
    const MOCK_CHAIN_ID = '1';
    const MOCK_CONFIG = {
      chains: {
        '1': {
          deployments: {
            multicall3: MOCK_MULTICALL_ADDRESS,
            everclear: '0xeverclear',
            permit2: '0xpermit2',
          },
        },
      },
    } as unknown as MarkConfiguration;

    afterEach(() => {
      sinon.restore();
    });

    it('should encode transaction data for a multicall with no values', () => {
      const calls = [
        {
          to: '0x1234567890123456789012345678901234567890',
          data: '0xabcdef01',
          value: '0',
        },
        {
          to: '0x2345678901234567890123456789012345678901',
          data: '0x12345678',
          value: '0',
        },
      ];

      // Generate the expected calldata using viem directly
      const formattedCalls = calls.map((call) => ({
        target: call.to as `0x${string}`,
        allowFailure: false,
        callData: call.data as `0x${string}`,
      }));

      const expectedCalldata = encodeFunctionData({
        abi: multicallAbi,
        functionName: 'aggregate3',
        args: [formattedCalls],
      });

      const result = prepareMulticall(calls, false, MOCK_CHAIN_ID, MOCK_CONFIG);

      expect(result).toHaveProperty('to');
      expect(result).toHaveProperty('data');
      expect(result.to).toBe(MOCK_MULTICALL_ADDRESS);
      expect(result.data).toBe(expectedCalldata);
      expect(result.value).toBe('0');
    });

    it('should encode transaction data for a multicall with values', () => {
      const calls = [
        {
          to: '0x1234567890123456789012345678901234567890',
          data: '0xabcdef01',
          value: '1000000000000000000', // 1 ETH
        },
        {
          to: '0x2345678901234567890123456789012345678901',
          data: '0x12345678',
          value: '2000000000000000000', // 2 ETH
        },
      ];

      // Generate the expected calldata using viem directly
      const formattedCalls = calls.map((call) => ({
        target: call.to as `0x${string}`,
        allowFailure: false,
        value: BigInt(call.value || '0'),
        callData: call.data as `0x${string}`,
      }));

      const expectedCalldata = encodeFunctionData({
        abi: multicallAbi,
        functionName: 'aggregate3Value',
        args: [formattedCalls],
      });

      const result = prepareMulticall(calls, true, MOCK_CHAIN_ID, MOCK_CONFIG);

      expect(result).toHaveProperty('to');
      expect(result).toHaveProperty('data');
      expect(result.to).toBe(MOCK_MULTICALL_ADDRESS);
      expect(result.data).toBe(expectedCalldata);
      expect(result.value).toBe('3000000000000000000'); // 3 ETH
    });

    it('should handle empty calls array', () => {
      const calls: Array<{
        to: string;
        data: string;
        value?: string;
      }> = [];

      // Generate the expected calldata using viem directly
      const formattedCalls: Array<{
        target: `0x${string}`;
        allowFailure: boolean;
        callData: `0x${string}`;
      }> = [];

      const expectedCalldata = encodeFunctionData({
        abi: multicallAbi,
        functionName: 'aggregate3',
        args: [formattedCalls],
      });

      const result = prepareMulticall(calls, false, MOCK_CHAIN_ID, MOCK_CONFIG);

      expect(result).toHaveProperty('to', MOCK_MULTICALL_ADDRESS);
      expect(result.data).toBe(expectedCalldata);
      expect(result.value).toBe('0');
    });

    it('should handle different value formats correctly', () => {
      const calls = [
        { to: '0x1234567890123456789012345678901234567890', data: '0xabcdef0123', value: '0x3b9aca00' }, // Hex: 1 billion (1e9)
        { to: '0x2345678901234567890123456789012345678901', data: '0x1234567890', value: '2000000000' }, // Decimal: 2 billion
      ];

      // Generate the expected calldata using viem directly
      const formattedCalls = calls.map((call) => {
        // Convert hex value to BigInt if needed
        const valueStr = call.value || '0';
        const value = valueStr.startsWith('0x') ? BigInt(parseInt(valueStr, 16)) : BigInt(valueStr);

        return {
          target: call.to as `0x${string}`,
          allowFailure: false,
          value,
          callData: call.data as `0x${string}`,
        };
      });

      const expectedCalldata = encodeFunctionData({
        abi: multicallAbi,
        functionName: 'aggregate3Value',
        args: [formattedCalls],
      });

      const result = prepareMulticall(calls, true, MOCK_CHAIN_ID, MOCK_CONFIG);

      expect(result.to).toBe(MOCK_MULTICALL_ADDRESS);
      expect(result.data).toBe(expectedCalldata);
      expect(result.value).toBe('3000000000'); // Sum should be 3 billion
    });

    it('should treat undefined values as zero', () => {
      const calls = [
        { to: '0x1234567890123456789012345678901234567890', data: '0xabcdef0123', value: '1000000000' },
        { to: '0x2345678901234567890123456789012345678901', data: '0x1234567890' }, // Undefined value
        { to: '0x3456789012345678901234567890123456789012', data: '0xaabbccddee', value: '0' }, // Explicit zero
      ];

      // Generate the expected calldata using viem directly
      const formattedCalls = calls.map((call) => ({
        target: call.to as `0x${string}`,
        allowFailure: false,
        value: BigInt(call.value || '0'),
        callData: call.data as `0x${string}`,
      }));

      const expectedCalldata = encodeFunctionData({
        abi: multicallAbi,
        functionName: 'aggregate3Value',
        args: [formattedCalls],
      });

      const result = prepareMulticall(calls, true, MOCK_CHAIN_ID, MOCK_CONFIG);

      expect(result.to).toBe(MOCK_MULTICALL_ADDRESS);
      expect(result.data).toBe(expectedCalldata);
      expect(result.value).toBe('1000000000'); // Only the first value should count
    });

    it('should work with a single call', () => {
      const calls = [{ to: '0x1234567890123456789012345678901234567890', data: '0xabcdef0123', value: '1000000000' }];

      // Generate the expected calldata using viem directly
      const formattedCalls = calls.map((call) => ({
        target: call.to as `0x${string}`,
        allowFailure: false,
        value: BigInt(call.value || '0'),
        callData: call.data as `0x${string}`,
      }));

      const expectedCalldata = encodeFunctionData({
        abi: multicallAbi,
        functionName: 'aggregate3Value',
        args: [formattedCalls],
      });

      const result = prepareMulticall(calls, true, MOCK_CHAIN_ID, MOCK_CONFIG);

      expect(result.to).toBe(MOCK_MULTICALL_ADDRESS);
      expect(result.data).toBe(expectedCalldata);
      expect(result.value).toBe('1000000000');
    });

    it('should use chain-specific address when provided', () => {
      const customAddress = '0x9876543210987654321098765432109876543210';
      const chainId = '123';
      const mockConfig = {
        chains: { '123': { deployments: { multicall3: customAddress } } },
      } as unknown as MarkConfiguration;

      const calls = [{ to: '0x1234567890123456789012345678901234567890', data: '0xabcdef01' }];

      const result = prepareMulticall(calls, false, chainId, mockConfig);

      expect(result.to).toBe(customAddress);
    });
  });
});
