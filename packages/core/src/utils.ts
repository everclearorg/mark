/**
 * Serializes an object containing BigInt values by converting them to strings
 * This is necessary because JSON.stringify() cannot serialize BigInt values
 */
export const serializeBigInt = (obj: unknown): unknown => {
  return JSON.parse(JSON.stringify(obj, (_, value) => (typeof value === 'bigint' ? value.toString() : value)));
};
