import { expect } from 'chai';
import { prepareMulticall } from '../../src/helpers/multicall';
import { MULTICALL_ADDRESS } from '../../src/helpers/contracts';
import sinon from 'sinon';
import { multicallAbi } from '../../src/helpers/contracts';
import { encodeFunctionData } from 'viem';

describe('Multicall Helper Functions', () => {
  describe('prepareMulticall', () => {
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
        const formattedCalls = calls.map(call => ({
            target: call.to as `0x${string}`,
            allowFailure: false,
            callData: call.data as `0x${string}`,
        }));

        const expectedCalldata = encodeFunctionData({
            abi: multicallAbi,
            functionName: 'aggregate3',
            args: [formattedCalls],
        });

        const result = prepareMulticall(calls, false);

        expect(result).to.have.property('to');
        expect(result).to.have.property('data');
        expect(result.to).to.equal(MULTICALL_ADDRESS);
        expect(result.data).to.equal(expectedCalldata);
        expect(result.value).to.equal('0');
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
        const formattedCalls = calls.map(call => ({
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

        const result = prepareMulticall(calls, true);

        expect(result).to.have.property('to');
        expect(result).to.have.property('data');
        expect(result.to).to.equal(MULTICALL_ADDRESS);
        expect(result.data).to.equal(expectedCalldata);
        expect(result.value).to.equal('3000000000000000000'); // 3 ETH
    });

    it('should handle empty calls array', () => {
        const calls: any[] = [];
        
        // Generate the expected calldata using viem directly
        const formattedCalls: Array<{
            target: `0x${string}`,
            allowFailure: boolean,
            callData: `0x${string}`
        }> = [];

        const expectedCalldata = encodeFunctionData({
            abi: multicallAbi,
            functionName: 'aggregate3',
            args: [formattedCalls],
        });

        const result = prepareMulticall(calls, false);

        expect(result).to.have.property('to', MULTICALL_ADDRESS);
        expect(result.data).to.equal(expectedCalldata);
        expect(result.value).to.equal('0');
    });

    it('should handle different value formats correctly', () => {
        const calls = [
            { to: '0x1234567890123456789012345678901234567890', data: '0xabcdef0123', value: '0x3b9aca00' }, // Hex: 1 billion (1e9)
            { to: '0x2345678901234567890123456789012345678901', data: '0x1234567890', value: '2000000000' }, // Decimal: 2 billion
        ];
        
        // Generate the expected calldata using viem directly
        const formattedCalls = calls.map(call => {
            // Convert hex value to BigInt if needed
            const valueStr = call.value || '0';
            const value = valueStr.startsWith('0x') ? 
                BigInt(parseInt(valueStr, 16)) : 
                BigInt(valueStr);
            
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
        
        const result = prepareMulticall(calls, true);
        
        expect(result.to).to.equal(MULTICALL_ADDRESS);
        expect(result.data).to.equal(expectedCalldata);
        expect(result.value).to.equal('3000000000'); // Sum should be 3 billion
    });

    it('should treat undefined values as zero', () => {
        const calls = [
            { to: '0x1234567890123456789012345678901234567890', data: '0xabcdef0123', value: '1000000000' },
            { to: '0x2345678901234567890123456789012345678901', data: '0x1234567890' }, // Undefined value
            { to: '0x3456789012345678901234567890123456789012', data: '0xaabbccddee', value: '0' }, // Explicit zero
        ];
        
        // Generate the expected calldata using viem directly
        const formattedCalls = calls.map(call => ({
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
        
        const result = prepareMulticall(calls, true);
        
        expect(result.to).to.equal(MULTICALL_ADDRESS);
        expect(result.data).to.equal(expectedCalldata);
        expect(result.value).to.equal('1000000000'); // Only the first value should count
    });

    it('should work with a single call', () => {
        const calls = [
            { to: '0x1234567890123456789012345678901234567890', data: '0xabcdef0123', value: '1000000000' },
        ];
        
        // Generate the expected calldata using viem directly
        const formattedCalls = calls.map(call => ({
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
        
        const result = prepareMulticall(calls, true);
        
        expect(result.to).to.equal(MULTICALL_ADDRESS);
        expect(result.data).to.equal(expectedCalldata);
        expect(result.value).to.equal('1000000000');
    });
  })
}); 