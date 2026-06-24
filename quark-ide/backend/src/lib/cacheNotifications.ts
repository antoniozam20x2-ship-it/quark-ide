import { EventEmitter } from 'events';

export interface CacheUpdateEvent {
  type: 'cache-update';
  repo: string;
  source: 'agent' | 'chat' | 'warroom';
  timestamp: string;
}

class CacheNotificationEmitter extends EventEmitter {}

export const cacheNotifications = new CacheNotificationEmitter();

console.log('[CACHE] EventEmitter initialized — listeners ready');
