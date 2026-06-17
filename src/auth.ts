import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { headerValue } from './util/shared.js';

type HeaderBag = Record<string, string | string[] | undefined>;

export function extractToken(headers: HeaderBag): string | undefined {
  const bearer = headerValue(headers, 'authorization');
  if (typeof bearer === 'string' && bearer.toLowerCase().startsWith('bearer ')) return bearer.slice('Bearer '.length).trim();
  const proxyKey = headerValue(headers, 'x-proxy-api-key');
  if (typeof proxyKey === 'string') return proxyKey.trim();
  return undefined;
}

function hashToken(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(hashToken(a), hashToken(b));
}

export function isAuthorized(headers: HeaderBag, allowedTokens: string[]): boolean {
  const presented = extractToken(headers);
  if (!presented || allowedTokens.length === 0) return false;
  return allowedTokens.some((token) => safeEqual(presented, token));
}

export function tokenId(token: string): string {
  // Use HMAC with salt for better security against brute force attacks
  const salt = 'exa-proxy-v1';
  return `tok_${createHmac('sha256', salt).update(token).digest('hex').slice(0, 12)}`;
}

export function presentedTokenId(headers: HeaderBag, allowedTokens: string[]): string | undefined {
  const presented = extractToken(headers);
  if (!presented) return undefined;
  const matched = allowedTokens.find((token) => safeEqual(presented, token));
  return matched ? tokenId(matched) : undefined;
}
