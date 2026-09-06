import http from 'node:http';
import https from 'node:https';
import type { Logger } from 'pino';

export type UpstreamHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

export interface UpstreamHealthState {
  readonly url: string;
  status: UpstreamHealthStatus;
  lastCheckedAt: number;
  consecutiveFailures: number;
  lastError?: string | undefined;
}

export interface UpstreamHealthOptions {
  readonly checkIntervalMs?: number | undefined;
  readonly checkTimeoutMs?: number | undefined;
  readonly healthPath?: string | undefined;
  readonly logger?: Logger | undefined;
}

export class UpstreamHealthTracker {
  private readonly states = new Map<string, UpstreamHealthState>();
  private readonly roundRobinIndices = new Map<string, number>();
  private readonly checkIntervalMs: number;
  private readonly checkTimeoutMs: number;
  private readonly healthPath: string;
  private readonly logger?: Logger | undefined;
  private timer?: NodeJS.Timeout | undefined;
  private isStopped = false;

  constructor(options: UpstreamHealthOptions = {}) {
    this.checkIntervalMs = options.checkIntervalMs ?? 2000;
    this.checkTimeoutMs = options.checkTimeoutMs ?? 1000;
    this.healthPath = options.healthPath ?? '/readyz';
    this.logger = options.logger;
  }

  public register(upstreamUrls: readonly string[]): void {
    for (const rawUrl of upstreamUrls) {
      const normalized = this.normalizeUrl(rawUrl);
      if (!this.states.has(normalized)) {
        this.states.set(normalized, {
          url: normalized,
          status: 'HEALTHY',
          lastCheckedAt: 0,
          consecutiveFailures: 0,
        });
      }
    }
  }

  public start(): void {
    if (this.timer || this.isStopped) return;
    this.pollAll();
    this.timer = setInterval(() => {
      this.pollAll();
    }, this.checkIntervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  public stop(): void {
    this.isStopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public markDegraded(upstreamUrl: string, errorMsg?: string): void {
    const normalized = this.normalizeUrl(upstreamUrl);
    let state = this.states.get(normalized);
    if (!state) {
      state = {
        url: normalized,
        status: 'DEGRADED',
        lastCheckedAt: Date.now(),
        consecutiveFailures: 1,
        lastError: errorMsg,
      };
      this.states.set(normalized, state);
    } else {
      state.status = 'DEGRADED';
      state.consecutiveFailures += 1;
      state.lastError = errorMsg;
    }

    this.logger?.warn(
      { upstream: normalized, failures: state.consecutiveFailures, error: errorMsg },
      'Upstream marked DEGRADED via connect-time failure'
    );
  }

  public markHealthy(upstreamUrl: string): void {
    const normalized = this.normalizeUrl(upstreamUrl);
    const state = this.states.get(normalized);
    if (state) {
      state.status = 'HEALTHY';
      state.consecutiveFailures = 0;
      state.lastError = undefined;
    }
  }

  public selectUpstream(
    routeId: string,
    candidates: readonly string[],
    excludeUrls?: ReadonlySet<string>
  ): string | undefined {
    if (candidates.length === 0) return undefined;

    const available = candidates.filter((url) => {
      const norm = this.normalizeUrl(url);
      return !excludeUrls || !excludeUrls.has(norm);
    });

    if (available.length === 0) return undefined;

    const readyCandidates = available.filter((url) => {
      const norm = this.normalizeUrl(url);
      const state = this.states.get(norm);
      return !state || state.status === 'HEALTHY';
    });

    const pool = readyCandidates.length > 0 ? readyCandidates : available;

    const currentIndex = this.roundRobinIndices.get(routeId) ?? 0;
    const selected = pool[currentIndex % pool.length];
    this.roundRobinIndices.set(routeId, (currentIndex + 1) % 1000000);

    return selected;
  }

  public getStatus(upstreamUrl: string): UpstreamHealthStatus {
    const normalized = this.normalizeUrl(upstreamUrl);
    return this.states.get(normalized)?.status ?? 'HEALTHY';
  }

  public getAllStates(): ReadonlyMap<string, Readonly<UpstreamHealthState>> {
    return this.states;
  }

  private pollAll(): void {
    if (this.isStopped) return;
    for (const [url] of this.states) {
      this.probeUpstream(url);
    }
  }

  private probeUpstream(upstreamUrl: string): void {
    try {
      const parsed = new URL(this.healthPath, upstreamUrl);
      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(
        {
          hostname: parsed.hostname,
          port: parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          timeout: this.checkTimeoutMs,
          headers: {
            'User-Agent': 'RouteX-HealthCheck/1.0',
            'Connection': 'close',
          },
        },
        (res) => {
          res.resume();
          const isHealthy = (res.statusCode ?? 500) < 400;
          this.recordProbeResult(upstreamUrl, isHealthy, `HTTP ${res.statusCode}`);
        }
      );

      req.on('timeout', () => {
        req.destroy();
        this.recordProbeResult(upstreamUrl, false, 'Health check timed out');
      });

      req.on('error', (err) => {
        this.recordProbeResult(upstreamUrl, false, err.message);
      });

      req.end();
    } catch (err: any) {
      this.recordProbeResult(upstreamUrl, false, err.message);
    }
  }

  private recordProbeResult(upstreamUrl: string, isHealthy: boolean, details?: string): void {
    const normalized = this.normalizeUrl(upstreamUrl);
    const state = this.states.get(normalized);
    if (!state) return;

    state.lastCheckedAt = Date.now();
    if (isHealthy) {
      if (state.status !== 'HEALTHY') {
        this.logger?.info({ upstream: normalized }, 'Upstream marked HEALTHY via /readyz probe');
      }
      state.status = 'HEALTHY';
      state.consecutiveFailures = 0;
      state.lastError = undefined;
    } else {
      state.consecutiveFailures += 1;
      state.status = 'UNHEALTHY';
      state.lastError = details;
      this.logger?.debug(
        { upstream: normalized, failures: state.consecutiveFailures, details },
        'Upstream failed /readyz probe'
      );
    }
  }

  private normalizeUrl(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
  }
}
