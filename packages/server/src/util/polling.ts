import { EventEmitter } from 'events';
import { tokenizeTopic } from 'util/parse-topics';
import services, { DataSource } from 'services';
import logger from 'common/logger';

// TODO: Normalize errors and re-architect polling vs socket
class PollingUtil extends EventEmitter {
    static DEFAULT_INTERVAL = 15000; // 15s - eth blocks are 13s
    static MEMPOOL_INTERVAL = 1000; // poll the mempool every 1s (via Infura)

    activeTopics: {
        [key: string]: { emitter: EventEmitter, interval: NodeJS.Timeout };
    } = {};

    // TODO
    // Make multi-tenant.

    subscribe(topic: string, interval: number = PollingUtil.DEFAULT_INTERVAL): EventEmitter {
        if (this.activeTopics[topic]) {
            // If topic is already active, no-op
            return this.activeTopics[topic].emitter;
        }

        return this.startPolling(topic, interval);
    }

    unsubscribe(topic: string): void {
        if (!this.activeTopics[topic]) {
            // If topic is not active, no-op
            logger.info(`Unsubscribe attempt for inactive topic: ${topic}`);
            return;
        }

        this.stopPolling(topic);
    }

    setInterval(intervalMs: number): void {
        for (const topic of Object.keys(this.activeTopics)) {
            this.stopPolling(topic);
            this.startPolling(topic, intervalMs);
        }

    }

    startPolling(topic: string, intervalMs?: number): EventEmitter {
        const [source, query, args] = tokenizeTopic(topic);

        if (query === '*' || args === '*') {
            throw new Error('Wildcards not yet implemented.');
        }

        const dataSource = services[source as DataSource];
        if (!dataSource) throw new Error(`Cannot start polling on data source ${source}`);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const queryFn = (dataSource as any)[query];
        if (!queryFn) throw new Error(`Query ${query} does not exist on data source ${source}`);

        const topicEmitter = new EventEmitter();

        // Assume args are comma-delimited
        const argsArr = args.split(',');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const interval: NodeJS.Timeout = <any>setInterval(() => {
            queryFn(...argsArr)
                .then((latest: unknown) => topicEmitter.emit('data', latest));
        }, intervalMs);

        // Unref prevents the interval from blocking app shutdown
        interval.unref();

        this.activeTopics[topic] = {
            emitter: topicEmitter,
            interval
        };

        return topicEmitter;
    }

    stopPolling(topic: string): boolean {
        if (!this.activeTopics[topic]) return false;

        // Clear interval for active topic and delete tracked topic
        clearInterval(this.activeTopics[topic].interval);
        delete this.activeTopics[topic];

        return true;
    }
}

export default new PollingUtil();