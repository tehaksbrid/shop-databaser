class Shopify {
    constructor(store, appconfig, logger) {
        this.appconfig = appconfig;
        this.domain = store.url;
        this.store = store;
        this.key = store.key;
        this.password = store.password;
        this._fs = require('fs');
        this._log = logger;
        this.token_monitoring = {
            request_pace: store.plus ? 750 : 1500,
            calls_max: store.plus ? 240 : 120,
            calls_made: [],
            calls_epoch: new Date().getTime(),
            registerCall: () => {
                this.token_monitoring.calls_made.push(new Date().getTime());
                this.token_monitoring.calls_made = this.token_monitoring.calls_made.filter(c => c > new Date().minusMinutes(5));
                let avg_usage = this.token_monitoring.calls_made.filter(c => c > new Date().minusMinutes(1)).length / this.token_monitoring.calls_max;
                if (avg_usage > 0.85) this.token_monitoring.request_pace = store.plus ? 1500 : 3000;
                else if (avg_usage > 0.65) this.token_monitoring.request_pace = store.plus ? 1100 : 2400;
                else this.token_monitoring.request_pace = store.plus ? 750 : 1500;
            },
            describe_usage: () => {
                return `${this.token_monitoring.quantify_usage()}% / ${this.token_monitoring.request_pace}ms`;
            },
            quantify_usage: () => {
                let calls = this.token_monitoring.calls_made.filter(c => c >= new Date().minusMinutes(1));
                return Math.ceil(100 * (calls.length / this.token_monitoring.calls_max));
            }
        };
        let axiosDefault = require('axios');
        this._axios = axiosDefault.create();
        this._axios.interceptors.request.use(config => {
            config.timing = {start: new Date().getTime()};
            return config;
        }, error => {
            config.timing = {start: new Date().getTime()};
            return Promise.reject(error);
        });
        this._axios.interceptors.response.use(response => {
            this.generalPurposeInterceptor(response);
            return response;
        }, error => {
            this.generalPurposeInterceptor(error);
            return Promise.reject(error);
        });
        this._rax = require('retry-axios');
        this._rax.attach(this._axios);
    }

    generalPurposeInterceptor(caller) {
        let url = new URL(caller.config.url);
        this.token_monitoring.registerCall();
        if (this.appconfig.logging.report_network_logs) this._log(`${caller.status} ${caller.config.method} ${url.hostname + url.pathname + url.search} (${this.token_monitoring.describe_usage()})`);
        caller.config.timing.end = new Date().getTime();
        caller.config.timing.duration = caller.config.timing.end - caller.config.timing.start;
    }

    get url() {
        return `https://${this.key}:${this.password}@${this.domain}`;
    }

    /**
     *  Delays sequential requests by 50-750 ms (1500 for non-plus stores)
     */
    async _throttle(request) {
        return new Promise(r => setTimeout(r, Math.max(this.token_monitoring.request_pace - request.config.timing.duration, 50)));
    }

    async _doGraphql(query, variables) {
        return this._axios({
            raxConfig: {
                // Retry 3 times on requests that return a response (500, etc) before giving up.  Defaults to 3.
                retry: 3,

                // Retry twice on errors that don't return a response (ENOTFOUND, ETIMEDOUT, etc).
                noResponseRetries: 2,

                // Milliseconds to delay at first.  Defaults to 100. Only considered when backoffType is 'static'
                retryDelay: 100,

                // HTTP methods to automatically retry.  Defaults to:
                // ['GET', 'HEAD', 'OPTIONS', 'DELETE', 'PUT']
                httpMethodsToRetry: ['OPTIONS', 'POST'],

                // The response status codes to retry.  Supports a double
                // array with a list of ranges.  Defaults to:
                // [[100, 199], [429, 429], [500, 599]]
                statusCodesToRetry: [[100, 199], [429, 429], [500, 599]],

                // If you are using a non static instance of Axios you need
                // to pass that instance here (const ax = axios.create())
                instance: this._axios,

                // You can set the backoff type.
                // options are 'exponential' (default), 'static' or 'linear'
                backoffType: 'exponential',

                // You can detect when a retry is happening, and figure out how many
                // retry attempts have been made
                onRetryAttempt: err => {
                    const cfg = this._rax.getConfig(err);
                    this._log(`Retry attempt #${cfg.currentRetryAttempt}`);
                }
            },
            url: `${this.url}/admin/api/2020-10/graphql.json`,
            headers: {
                "X-Shopify-Access-Token": this.password
            },
            method: 'post',
            data: {
                query: query,
                variables: variables
            }
        });
    }

    async _doGet(url) {
        return this._axios({
            url: url,
            raxConfig: {
                // Retry 3 times on requests that return a response (500, etc) before giving up.  Defaults to 3.
                retry: 3,

                // Retry twice on errors that don't return a response (ENOTFOUND, ETIMEDOUT, etc).
                noResponseRetries: 2,

                // Milliseconds to delay at first.  Defaults to 100. Only considered when backoffType is 'static'
                retryDelay: 100,

                // HTTP methods to automatically retry.  Defaults to:
                // ['GET', 'HEAD', 'OPTIONS', 'DELETE', 'PUT']
                httpMethodsToRetry: ['GET', 'HEAD', 'OPTIONS', 'DELETE', 'PUT'],

                // The response status codes to retry.  Supports a double
                // array with a list of ranges.  Defaults to:
                // [[100, 199], [429, 429], [500, 599]]
                statusCodesToRetry: [[100, 199], [429, 429], [500, 599]],

                // If you are using a non static instance of Axios you need
                // to pass that instance here (const ax = axios.create())
                instance: this._axios,

                // You can set the backoff type.
                // options are 'exponential' (default), 'static' or 'linear'
                backoffType: 'exponential',

                // You can detect when a retry is happening, and figure out how many
                // retry attempts have been made
                onRetryAttempt: err => {
                    const cfg = this._rax.getConfig(err);
                    this._log(`Retry attempt #${cfg.currentRetryAttempt}`);
                }
            }
        });
    }

    /**
     *  Assumes:
     *  1) HBP (header based pagination)
     *  2) Responses are structured as: {resource: []}
     *  3) Desired output is [...Response1.resource, ..., ...ResponseN.resource]
     */
    async _recursiveRead(path, params) {
        let readComplete = false;
        let accumulatedResults = [];
        do {
            let response = await this._doGet(this.url + path + params)
                .catch(err => {
                    this._log(`Request failure. Resource (if defined): ${err?.config?.url}\n Message: ${err.message}`);
                    return {data: [], headers: {}, config: {timing: {duration: 0}}};
                });
            // Check for and store results
            let results = Object.values(response.data);
            if (Array.isArray(results[0])) accumulatedResults = accumulatedResults.concat(results[0]);

            // Check for next page
            if (!!response.headers.link && response.headers.link.includes('rel="next"')) {
                let head = response.headers.link;
                head = head.split(path);
                params = head[head.length - 1].split(">;")[0];
            } else readComplete = true;

            await this._throttle(response);
        } while (readComplete === false)
        return accumulatedResults;
    }

    /**
     *  Assumes:
     *  1) Single object result is expected
     *  2) Response format: {key: result}
     *  3) Desired output is {...result}
     */
    async _objectRead(path, params) {
        let response = await this._doGet(this.url + path + params)
            .catch(err => {
                this._log(`Request failure. Resource (if defined): ${err?.config?.url}\n Message: ${err.message}`);
                return {data: [], headers: {}, config: {timing: {duration: 0}}};
            });
        await this._throttle(response);
        return Object.values(response.data)[0];
    }

    async getFulfillmentEvents(gidArray) {
        let query = `query ($fulfillment_ids: [ID!]!) {
            nodes(ids: $fulfillment_ids) {
                ...on Fulfillment {
                    id
                    events(first: 50) {
                        edges {
                            node {
                                status
                                happenedAt
                            }
                        }
                    }
                }
            }
        }`;
        let variables = {
            fulfillment_ids: gidArray
        };
        let resp = await this._doGraphql(query, variables)
            .catch(err => {
                this._log(`Read fulfillment events failure. Resource (if defined): ${err?.config?.url}\n Message: ${err.message}`);
                return {
                    data: {
                        data: {
                            nodes: gidArray.map(gid => {
                                return {
                                    id: gid,
                                    events: {
                                        edges: []
                                    }
                                }
                            })
                        }
                    }
                };
            });
        return resp.data.data.nodes.map(g => {
            return {
                gid: g.id,
                events: g.events.edges.map(edge => edge.node)
            };
        });
    }

    async getInventoryItems(idArray) {
        let path = `/admin/api/2020-10/inventory_items.json`;
        let params = `?ids=${idArray.toString()}&limit=100`;
        return this._recursiveRead(path, params);
    }

    async getOrdersByDate(from, to) {
        // Shopify is known to be a bit inaccurate with these filters
        // If we use perfectly exclusive date rates, we may miss orders
        let practicalFromDate = from.minusMinutes(180);
        let practicalToDate = to.plusMinutes(180);

        let path = `/admin/api/2020-10/orders.json`;
        let params = `?created_at_min=${practicalFromDate.toShopifyString()}&created_at_max=${practicalToDate.toShopifyString()}&status=any&limit=250`
        return this._recursiveRead(path, params);
    }

    async getOrdersById(idArray) {
        if (idArray.length === 0) return [];
        let path = `/admin/api/2020-10/orders.json`;
        let orders = [];
        for (let chunk of idArray.chunk(250)) {
            let params = `?limit=250&status=any&ids=${chunk.toString()}`;
            let results = await this._recursiveRead(path, params);
            orders = orders.concat(results);
        }
        return orders;
    }

    async getCustomersByUpdatedDate(from, to) {
        let path = `/admin/api/2020-10/customers.json`;
        let params = `?updated_at_min=${from.toShopifyString()}&updated_at_max=${to.toShopifyString()}&limit=250`;
        return this._recursiveRead(path, params);
    }

    async getCustomersByDate(from, to) {
        // Shopify is known to be a bit inaccurate with these filters
        // If we use perfectly exclusive date rates, we may miss orders
        let practicalFromDate = from.minusMinutes(180);
        let practicalToDate = to.plusMinutes(180);

        let path = `/admin/api/2020-10/customers.json`;
        let params = `?created_at_min=${practicalFromDate.toShopifyString()}&created_at_max=${practicalToDate.toShopifyString()}&limit=250`;
        return this._recursiveRead(path, params);
    }

    async getProductsById(idArray) {
        if (idArray.length === 0) return [];
        let path = `/admin/api/2020-10/products.json`;
        let products = [];
        for (let chunk of idArray.chunk(250)) {
            let params = `?ids=${chunk.toString()}&limit=250`;
            let results = await this._recursiveRead(path, params);
            products = products.concat(results);
        }
        return products;
    }

    async getProductsByDate(from, to) {
        // Shopify is known to be a bit inaccurate with these filters
        // If we use perfectly exclusive date rates, we may miss orders
        let practicalFromDate = from.minusMinutes(180);
        let practicalToDate = to.plusMinutes(180);

        let path = `/admin/api/2020-10/products.json`;
        let params = `?created_at_min=${practicalFromDate.toShopifyString()}&created_at_max=${practicalToDate.toShopifyString()}&limit=250`;
        return this._recursiveRead(path, params);
    }

    async getPriceRulesByUpdatedDate(from, to) {
        let path = `/admin/api/unstable/price_rules.json`;
        let params = `?updated_at_min=${from.toShopifyString()}&updated_at_max=${to.toShopifyString()}&limit=250`;
        return this._recursiveRead(path, params);
    }

    async getPriceRulesByDate(from, to) {
        // Shopify is known to be a bit inaccurate with these filters
        // If we use perfectly exclusive date rates, we may miss orders
        let practicalFromDate = from.minusMinutes(180);
        let practicalToDate = to.plusMinutes(180);

        let path = `/admin/api/unstable/price_rules.json`;
        let params = `?created_at_min=${practicalFromDate.toShopifyString()}&created_at_max=${practicalToDate.toShopifyString()}&limit=250`;
        return this._recursiveRead(path, params);
    }

    async getShop() {
        let path = `/admin/api/2020-10/shop.json`;
        let params = ``;
        return this._objectRead(path, params);
    }

    /**
     *  Enumerate Order/Product events from the last N minutes
     */
    async getRecentEvents({from, to}) {
        let path = `/admin/api/2020-10/events.json`;
        let params = `?limit=250&created_at_min=${from.minusMinutes(60).toShopifyString()}&created_at_max=${to.plusMinutes(60).toShopifyString()}&filter=Order,Product`;
        return this._recursiveRead(path, params);
    }
}

exports.Shopify = Shopify;