/**
 * Serializes an object containing BigInt values by converting them to strings
 * This is necessary because JSON.stringify() cannot serialize BigInt values
 * Also handles circular references by tracking seen objects
 */
export const serializeBigInt = (obj: unknown): unknown => {
  const seen = new WeakSet();
  return JSON.parse(
    JSON.stringify(obj, (_, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return undefined; // Remove circular reference
        }
        seen.add(value);
      }
      return value;
    }),
  );
};
