import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import { RequestContext } from './types';
import { ILogger } from '@mark/logger';

export const createLoggingContext = (method: string, context?: RequestContext) => {
  return {
    requestContext: context ?? { id: uuid() },
    methodContext: { method },
  };
};

export interface FileDescriptorStats {
  current: number;
  limit: number;
  percentage: number;
  warning: boolean;
  critical: boolean;
}

/**
 * Get current file descriptor usage statistics
 */
export function getFileDescriptorStats(): FileDescriptorStats {
  let current = 0;
  let limit = 1024; // AWS Lambda default

  try {
    // Try to get actual file descriptor count on Unix systems
    if (process.platform !== 'win32') {
      const fdDir = `/proc/${process.pid}/fd`;
      if (fs.existsSync(fdDir)) {
        current = fs.readdirSync(fdDir).length;
      }
    }

    // Try to get actual limit (getrlimit may not exist on all Node.js versions)
    const processWithRlimit = process as unknown as {
      getrlimit?: (resource: string) => { soft: number; hard: number };
    };
    if (typeof processWithRlimit.getrlimit === 'function') {
      const rlimit = processWithRlimit.getrlimit('nofile');
      limit = rlimit.soft;
    }
  } catch (error) {
    console.warn('Could not get file descriptor stats:', error);
  }

  const percentage = (current / limit) * 100;

  return {
    current,
    limit,
    percentage,
    warning: percentage > 70, // Warning at 70%
    critical: percentage > 90, // Critical at 90%
  };
}

/**
 * Log file descriptor usage with appropriate log level
 */
export function logFileDescriptorUsage(logger?: ILogger): void {
  const stats = getFileDescriptorStats();

  const logData = {
    fileDescriptors: {
      current: stats.current,
      limit: stats.limit,
      percentage: Math.round(stats.percentage * 100) / 100,
    },
  };

  if (stats.critical) {
    logger?.error('CRITICAL: File descriptor usage is very high', logData);
  } else if (stats.warning) {
    logger?.warn('WARNING: File descriptor usage is high', logData);
  } else {
    logger?.info('File descriptor usage normal', logData);
  }
}

/**
 * Check if we should exit the process to prevent EMFILE errors
 */
export function shouldExitForFileDescriptors(): boolean {
  const stats = getFileDescriptorStats();
  return stats.percentage > 95; // Exit if over 95% usage
}
