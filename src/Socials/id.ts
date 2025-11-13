import { randomBytes } from "crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const encodeTime = (time: number, len: number): string => {
  let value = time;
  let output = "";
  for (let i = 0; i < len; i += 1) {
    const mod = value % 32;
    output = CROCKFORD[mod] + output;
    value = Math.floor(value / 32);
  }
  return output;
};

const encodeRandom = (bytes: Buffer): string => {
  let result = "";
  for (const byte of bytes) {
    result += CROCKFORD[byte >> 3];
  }
  return result;
};

export const generateRequestId = (): string => {
  const time = Date.now();
  const timeComponent = encodeTime(time, 10);
  const randomComponent = encodeRandom(randomBytes(8));
  return `${timeComponent}${randomComponent}`;
};
