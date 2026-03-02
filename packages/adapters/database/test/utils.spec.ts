import { snakeToCamel, camelToSnake, normalizeReceipt, isNormalizedReceipt } from '../src/utils';

describe('Database Utils', () => {
  describe('snakeToCamel', () => {
    it('should convert simple snake_case keys to camelCase', () => {
      const input = {
        user_name: 'john',
        email_address: 'john@example.com',
        is_active: true,
      };

      const result = snakeToCamel(input);

      expect(result).toEqual({
        userName: 'john',
        emailAddress: 'john@example.com',
        isActive: true,
      });
    });

    it('should handle nested objects', () => {
      const input = {
        user_profile: {
          first_name: 'John',
          last_name: 'Doe',
          contact_info: {
            phone_number: '123-456-7890',
            home_address: '123 Main St',
          },
        },
      };

      const result = snakeToCamel(input);

      expect(result).toEqual({
        userProfile: {
          firstName: 'John',
          lastName: 'Doe',
          contactInfo: {
            phoneNumber: '123-456-7890',
            homeAddress: '123 Main St',
          },
        },
      });
    });

    it('should handle arrays of objects', () => {
      const input = {
        user_list: [
          { user_id: 1, user_name: 'john' },
          { user_id: 2, user_name: 'jane' },
        ],
      };

      const result = snakeToCamel(input);

      expect(result).toEqual({
        userList: [
          { userId: 1, userName: 'john' },
          { userId: 2, userName: 'jane' },
        ],
      });
    });

    it('should handle arrays of primitives', () => {
      const input = {
        user_ids: [1, 2, 3],
        status_codes: ['active', 'inactive'],
      };

      const result = snakeToCamel(input);

      expect(result).toEqual({
        userIds: [1, 2, 3],
        statusCodes: ['active', 'inactive'],
      });
    });

    it('should preserve Date objects', () => {
      const date = new Date('2023-01-01');
      const input = {
        created_at: date,
        updated_at: date,
      };

      const result = snakeToCamel(input);

      expect(result).toEqual({
        createdAt: date,
        updatedAt: date,
      });
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it('should handle null and undefined values', () => {
      const input = {
        nullable_field: null,
        undefined_field: undefined,
      };

      const result = snakeToCamel(input);

      expect(result).toEqual({
        nullableField: null,
        undefinedField: undefined,
      });
    });

    it('should handle empty objects', () => {
      const input = {};
      const result = snakeToCamel(input);
      expect(result).toEqual({});
    });

    it('should handle objects with no snake_case keys', () => {
      const input = {
        name: 'john',
        age: 30,
        active: true,
      };

      const result = snakeToCamel(input);

      expect(result).toEqual({
        name: 'john',
        age: 30,
        active: true,
      });
    });

    it('should handle top-level arrays', () => {
      const input = [
        { user_id: 1, user_name: 'john' },
        { user_id: 2, user_name: 'jane' },
      ];

      const result = snakeToCamel(input);

      expect(result).toEqual([
        { userId: 1, userName: 'john' },
        { userId: 2, userName: 'jane' },
      ]);
    });

    it('should handle null input', () => {
      const result = snakeToCamel(null as unknown as object);
      expect(result).toBeNull();
    });

    it('should handle undefined input', () => {
      const result = snakeToCamel(undefined as unknown as object);
      expect(result).toBeUndefined();
    });

    it('should handle primitive values', () => {
      expect(snakeToCamel('string' as unknown as object)).toBe('string');
      expect(snakeToCamel(123 as unknown as object)).toBe(123);
      expect(snakeToCamel(true as unknown as object)).toBe(true);
    });

    it('should handle multiple underscores correctly', () => {
      const input = {
        user_profile_data: 'value',
        is_user_active: true,
      };

      const result = snakeToCamel(input);

      expect(result).toEqual({
        userProfileData: 'value',
        isUserActive: true,
      });
    });
  });

  describe('camelToSnake', () => {
    it('should convert simple camelCase keys to snake_case', () => {
      const input = {
        userName: 'john',
        emailAddress: 'john@example.com',
        isActive: true,
      };

      const result = camelToSnake(input);

      expect(result).toEqual({
        user_name: 'john',
        email_address: 'john@example.com',
        is_active: true,
      });
    });

    it('should handle nested objects', () => {
      const input = {
        userProfile: {
          firstName: 'John',
          lastName: 'Doe',
          contactInfo: {
            phoneNumber: '123-456-7890',
            homeAddress: '123 Main St',
          },
        },
      };

      const result = camelToSnake(input);

      expect(result).toEqual({
        user_profile: {
          first_name: 'John',
          last_name: 'Doe',
          contact_info: {
            phone_number: '123-456-7890',
            home_address: '123 Main St',
          },
        },
      });
    });

    it('should handle arrays of objects', () => {
      const input = {
        userList: [
          { userId: 1, userName: 'john' },
          { userId: 2, userName: 'jane' },
        ],
      };

      const result = camelToSnake(input);

      expect(result).toEqual({
        user_list: [
          { user_id: 1, user_name: 'john' },
          { user_id: 2, user_name: 'jane' },
        ],
      });
    });

    it('should handle arrays of primitives', () => {
      const input = {
        userIds: [1, 2, 3],
        statusCodes: ['active', 'inactive'],
      };

      const result = camelToSnake(input);

      expect(result).toEqual({
        user_ids: [1, 2, 3],
        status_codes: ['active', 'inactive'],
      });
    });

    it('should preserve Date objects', () => {
      const date = new Date('2023-01-01');
      const input = {
        createdAt: date,
        updatedAt: date,
      };

      const result = camelToSnake(input);

      expect(result).toEqual({
        created_at: date,
        updated_at: date,
      });
      expect(result.created_at).toBeInstanceOf(Date);
    });

    it('should handle null and undefined values', () => {
      const input = {
        nullableField: null,
        undefinedField: undefined,
      };

      const result = camelToSnake(input);

      expect(result).toEqual({
        nullable_field: null,
        undefined_field: undefined,
      });
    });

    it('should handle empty objects', () => {
      const input = {};
      const result = camelToSnake(input);
      expect(result).toEqual({});
    });

    it('should handle objects with no camelCase keys', () => {
      const input = {
        name: 'john',
        age: 30,
        active: true,
      };

      const result = camelToSnake(input);

      expect(result).toEqual({
        name: 'john',
        age: 30,
        active: true,
      });
    });

    it('should handle top-level arrays', () => {
      const input = [
        { userId: 1, userName: 'john' },
        { userId: 2, userName: 'jane' },
      ];

      const result = camelToSnake(input);

      expect(result).toEqual([
        { user_id: 1, user_name: 'john' },
        { user_id: 2, user_name: 'jane' },
      ]);
    });

    it('should handle null input', () => {
      const result = camelToSnake(null as unknown as object);
      expect(result).toBeNull();
    });

    it('should handle undefined input', () => {
      const result = camelToSnake(undefined as unknown as object);
      expect(result).toBeUndefined();
    });

    it('should handle primitive values', () => {
      expect(camelToSnake('string' as unknown as object)).toBe('string');
      expect(camelToSnake(123 as unknown as object)).toBe(123);
      expect(camelToSnake(true as unknown as object)).toBe(true);
    });

    it('should handle consecutive capital letters correctly', () => {
      const input = {
        userID: 123,
        XMLParser: 'parser',
        HTTPRequest: 'request',
      };

      const result = camelToSnake(input);

      expect(result).toEqual({
        user_i_d: 123,
        x_m_l_parser: 'parser',
        h_t_t_p_request: 'request',
      });
    });

    it('should not add leading underscore', () => {
      const input = {
        APIKey: 'key',
        URLPath: '/path',
      };

      const result = camelToSnake(input);

      expect(result).toEqual({
        a_p_i_key: 'key',
        u_r_l_path: '/path',
      });
    });
  });

  describe('normalizeReceipt', () => {
    it('should normalize a valid receipt with all fields', () => {
      const receipt = {
        transactionHash: '0xabc123',
        from: '0xsender',
        to: '0xrecipient',
        cumulativeGasUsed: '21000',
        effectiveGasPrice: '20000000000',
        blockNumber: 12345,
        status: 'success',
        logs: [{ topic: '0x1' }],
        confirmations: 5,
      };

      const result = normalizeReceipt(receipt);

      expect(result.transactionHash).toBe('0xabc123');
      expect(result.from).toBe('0xsender');
      expect(result.to).toBe('0xrecipient');
      expect(result.cumulativeGasUsed).toBe('21000');
      expect(result.effectiveGasPrice).toBe('20000000000');
      expect(result.blockNumber).toBe(12345);
      expect(result.status).toBe(1);
      expect(result.logs).toEqual([{ topic: '0x1' }]);
      expect(result.confirmations).toBe(5);
    });

    it('should throw error when transactionHash is missing', () => {
      const receipt = { from: '0xsender', to: '0xrecipient' };
      expect(() => normalizeReceipt(receipt)).toThrow(/missing or invalid transactionHash/);
    });

    it('should throw error when from is missing', () => {
      const receipt = { transactionHash: '0xabc', to: '0xrecipient' };
      expect(() => normalizeReceipt(receipt)).toThrow(/missing or invalid 'from' address/);
    });

    it('should default to empty string when to is missing', () => {
      const receipt = {
        transactionHash: '0xabc',
        from: '0xsender',
        to: null,
        cumulativeGasUsed: '0',
        effectiveGasPrice: '0',
        blockNumber: 0,
      };

      const result = normalizeReceipt(receipt);
      expect(result.to).toBe('');
    });

    it('should use gasPrice as fallback when effectiveGasPrice is missing', () => {
      const receipt = {
        transactionHash: '0xabc',
        from: '0xsender',
        to: '0xrecipient',
        cumulativeGasUsed: '21000',
        gasPrice: '15000000000',
        blockNumber: 100,
      };

      const result = normalizeReceipt(receipt);
      expect(result.effectiveGasPrice).toBe('15000000000');
    });

    it('should map status "success" to 1 and other values to undefined', () => {
      const successReceipt = {
        transactionHash: '0xabc',
        from: '0xsender',
        to: '0xrecipient',
        status: 'success',
      };
      expect(normalizeReceipt(successReceipt).status).toBe(1);

      const numericSuccessReceipt = {
        transactionHash: '0xdef',
        from: '0xsender',
        to: '0xrecipient',
        status: 1,
      };
      expect(normalizeReceipt(numericSuccessReceipt).status).toBe(1);

      const failedReceipt = {
        transactionHash: '0xghi',
        from: '0xsender',
        to: '0xrecipient',
        status: 'failed',
      };
      expect(normalizeReceipt(failedReceipt).status).toBeUndefined();
    });

    it('should default logs to empty array when missing', () => {
      const receipt = {
        transactionHash: '0xabc',
        from: '0xsender',
        to: '0xrecipient',
      };

      const result = normalizeReceipt(receipt);
      expect(result.logs).toEqual([]);
    });

    it('should handle confirmations as number vs non-number', () => {
      const withNumericConfirmations = {
        transactionHash: '0xabc',
        from: '0xsender',
        to: '0xrecipient',
        confirmations: 10,
      };
      expect(normalizeReceipt(withNumericConfirmations).confirmations).toBe(10);

      const withStringConfirmations = {
        transactionHash: '0xdef',
        from: '0xsender',
        to: '0xrecipient',
        confirmations: '5',
      };
      expect(normalizeReceipt(withStringConfirmations).confirmations).toBeUndefined();
    });
  });

  describe('isNormalizedReceipt', () => {
    it('should return true for a valid normalized receipt', () => {
      const receipt = {
        transactionHash: '0xabc',
        from: '0xsender',
        to: '0xrecipient',
        cumulativeGasUsed: '21000',
        effectiveGasPrice: '20000000000',
        blockNumber: 12345,
        status: 1,
        logs: [],
      };

      expect(isNormalizedReceipt(receipt)).toBe(true);
    });

    it('should return false when fields have wrong types', () => {
      expect(isNormalizedReceipt({ transactionHash: 123 })).toBe(false);
      expect(isNormalizedReceipt({
        transactionHash: '0x',
        from: '0x',
        to: '0x',
        cumulativeGasUsed: '0',
        effectiveGasPrice: '0',
        blockNumber: 'not-a-number',
        status: 1,
        logs: [],
      })).toBe(false);
    });

    it('should return false for null or undefined input', () => {
      expect(isNormalizedReceipt(null)).toBe(false);
      expect(isNormalizedReceipt(undefined)).toBe(false);
    });
  });

  describe('Bidirectional conversion', () => {
    it('should be reversible for snake_case to camelCase', () => {
      const original = {
        user_name: 'john',
        user_profile: {
          first_name: 'John',
          contact_info: {
            phone_number: '123-456-7890',
          },
        },
        user_list: [{ user_id: 1, is_active: true }],
      };

      const camelCased = snakeToCamel(original);
      const backToSnake = camelToSnake(camelCased);

      expect(backToSnake).toEqual(original);
    });

    it('should be reversible for simple camelCase to snake_case', () => {
      const original = {
        userName: 'john',
        userProfile: {
          firstName: 'John',
          contactInfo: {
            phoneNumber: '123-456-7890',
          },
        },
        userList: [{ userId: 1, isActive: true }],
      };

      const snakeCased = camelToSnake(original);
      const backToCamel = snakeToCamel(snakeCased);

      expect(backToCamel).toEqual(original);
    });
  });
});
