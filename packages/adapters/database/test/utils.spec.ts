import { snakeToCamel, camelToSnake } from '../src/utils';

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
      const result = snakeToCamel(null as any);
      expect(result).toBeNull();
    });

    it('should handle undefined input', () => {
      const result = snakeToCamel(undefined as any);
      expect(result).toBeUndefined();
    });

    it('should handle primitive values', () => {
      expect(snakeToCamel('string' as any)).toBe('string');
      expect(snakeToCamel(123 as any)).toBe(123);
      expect(snakeToCamel(true as any)).toBe(true);
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
      const result = camelToSnake(null as any);
      expect(result).toBeNull();
    });

    it('should handle undefined input', () => {
      const result = camelToSnake(undefined as any);
      expect(result).toBeUndefined();
    });

    it('should handle primitive values', () => {
      expect(camelToSnake('string' as any)).toBe('string');
      expect(camelToSnake(123 as any)).toBe(123);
      expect(camelToSnake(true as any)).toBe(true);
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
        user_list: [
          { user_id: 1, is_active: true },
        ],
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
        userList: [
          { userId: 1, isActive: true },
        ],
      };

      const snakeCased = camelToSnake(original);
      const backToCamel = snakeToCamel(snakeCased);

      expect(backToCamel).toEqual(original);
    });
  });
});