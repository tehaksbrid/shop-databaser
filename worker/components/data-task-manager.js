/**
 *  Calls the network & database tasks required to maintain local Shopify databases.
 *      -Decides how data is read from Shopify
 *      -Sends results to database for storage
 *      -Produces a recursive loop of tasks
 *      -Directly controls its own config file, describing where it left off when reading data from Shopify for each store-instance
 */


// TODO -- quit during database validation may corrupt database
const path = require('path');
const {remote} = require('electron');
const app = remote.app;

class DataTaskManager {
    constructor(store, appconfig, statusCb) {
        this.appconfig = appconfig;
        this._fs = require('fs');
        let {Shopify} = require(path.join(__dirname, './shopify'));
        let {Database} = require(path.join(__dirname, './database'));
        this.shopify = new Shopify(store, appconfig, this._log);
        this.db = new Database(store, appconfig, this._log);
        this.store = store;
        this.statusCb = statusCb;
        this.taskStatus = {
            store: store,
            shop: false,
            properties: []
        };
        this.queue = [];
        if (this._metadataExists()) this._metadata = this._readMetadata();
        else this._metadata = {
            recent_read_cursor: new Date().getTime(),
            last_sync: 0,
            force_gc: false,
            step: 1,
            dataObjectCounts: {},
            dataObjectCount: 0,
            dataFileCount: 0,
            shop: {
                max_steps: null
            }
        };
    }

    updateConfig(c) {
        this.appconfig = c;
        this.shopify.appconfig = c;
        this.db.appconfig = c;
    }

    async run() {
        // Complete previous task queue
        let begin = new Date().getTime();
        await Promise.all(this.queue);

        // Handle disconnection of store
        // Done after the previous queue clears
        if (this.disconnect) return this._doDisconnect();

        // Hold for some amount of time between executions
        this.duration = new Date().getTime() - begin;
        if (this.duration < this.appconfig.general.minimum_duration) await new Promise(r => setTimeout(r, this.appconfig.general.minimum_duration - this.duration));
        // Describe resource usage
        if (this.db.initialized === true) await this._sendLogs();

        // Decide what the next tasks will be
        if (navigator.onLine === false) {
            return this.run();
        } else if (this.db.initialized === false) {
            // Validates directory structure and checks index/file integrity
            this._log(`Initializing DB ${this.store.name}`);
            await this.db.initialize();
            // If an index file was corrupted
            if (this.db.indexFailure === true) this._metadata.step = 0;
        } else if (this._metadata.f_factor > 1.1 || this._metadata.force_gc) {
            // Purge stale references and merge small files
            this._log(`Running GC for ${this.store.name}`);
            await this.db._validateIndexContents();
            this.queue = this.db.gcTasks();
            this._metadata.f_factor = 0;
            this._metadata.force_gc = false;
        } else {
            // Generate an array of promises, each reading then writing specific information from Shopify
            this.queue = await this.generateReadQueue();
            if (this._metadata.shop.max_steps === this._metadata.step + 1) {
                this._metadata.last_sync = new Date().getTime();
                this._metadata.force_gc = true;
            }
            Promise.all(this.queue).then(r => {
                // Application exits may cause partial writes, we'd like to ensure we get everything before proceeding
                if (this._metadata.shop.max_steps >= this._metadata.step) this._metadata.step++;
            });
        }

        // Trigger re-sync based on metadata.last_sync
        if ((this._metadata.last_sync + this.appconfig.general.sync_frequency) <= new Date().getTime()) {
            this._metadata.last_sync = new Date().getTime();
            this._metadata.step = 0;
        }

        // Record changes to metadata and begin the next run
        await this._writeMetadata();

        // Begin the run we just scheduled
        return this.run();
    }

    async _doDisconnect() {
        await this.db.deleteAll();
        this.deleteAll();
        return Promise.resolve();
    }

    deleteAll() {
        this._fs.unlinkSync(this._getMetadataUrl());
        this._fs.unlinkSync(this._getLogFileUrl());
    }

    async forceSync() {
        this._metadata.last_sync = 0;
        return this._writeMetadata();
    }

    /**
     * Generate N data read tasks and enter them into the queue
     */
    async generateReadQueue() {
        // If we're done with step reads + the last update read had little information, sleep for an increasing amount of time
        // Reset once we start receiving data again
        let queueResult = await Promise.all(this.queue);
        let dataFromLastCycle = queueResult.reduce((data, taskResult) => {
            Object.values(taskResult || {}).forEach(r => data = data.concat(r));
            return data;
        }, []);
        if (this._metadata.shop.max_steps <= this._metadata.step && queueResult.length > 0 && dataFromLastCycle.length < this.appconfig.general.no_data_threshold) {
            this._metadata.last_nodata_sleep = this._metadata.last_nodata_sleep ? Math.min(Math.floor(1.1 * this._metadata.last_nodata_sleep), 6e5) : this.appconfig.general.no_data_default_sleep;
            await new Promise(r => setTimeout(r, this._metadata.last_nodata_sleep));
        } else this._metadata.last_nodata_sleep = this.appconfig.general.no_data_default_sleep;

        // fulfillment-events + inventory both use results from last cycle (vs current cycle) to improve parallelism
        let {fulfillments: fulfillmentsFromLastCycle} = queueResult.find(r => r?.fulfillments) || {fulfillments: []};
        let {products: productsFromLastCycle} = queueResult.find(r => r?.products) || {products: []};

        // Obtains order data
        this.queue = [];
        let recentDateRange = this._getRecentDateRange();
        this._metadata.recent_read_cursor = recentDateRange.to.getTime();
        let recentEvents = await this.shopify.getRecentEvents(recentDateRange);
        let orderTasks = this.generateOrderTasks(recentEvents);
        let customerTasks = this.generateCustomerTasks(recentEvents);
        let productTasks = this.generateProductTasks(recentEvents);
        let discountTasks = this.generateDiscountTasks(recentEvents);
        let inventoryTasks = this.generateInventoryTasks(productsFromLastCycle);

        return [orderTasks, customerTasks, productTasks, discountTasks, inventoryTasks];
    }

    /**
     * Uses events to catch up on recently updated orders
     * Walks back in time to eventually read all orders
     *
     * Fulfillments are taken out and stored independently.
     * Customer objects are replaced with the customer ID.
     *
     * For a store open for 365 days @ 250 orders per day & 8s per request, this would take approximately 48 minutes
     */
    async generateOrderTasks(events) {

        let updatedOrderIds = events.filter(ev => ev["subject_type"] === "Order").map(ev => ev["subject_id"]);
        let orderUpdates = await this.shopify.getOrdersById(updatedOrderIds);

        let dateStepOrders = [];
        let currentDayStep = this._metadata.step;
        if (!this._metadata.shop.max_steps || currentDayStep <= this._metadata.shop.max_steps) {
            let from = new Date().minusDays(currentDayStep);
            let to = new Date().minusDays(currentDayStep - 1);
            dateStepOrders = await this.shopify.getOrdersByDate(from, to);
        }

        [...dateStepOrders, ...orderUpdates].forEach(o => o.customer = o.customer?.id || null);

        let fulfillmentData = [...dateStepOrders, ...orderUpdates].flatMap(o => {
            let fulfillments = JSON.parse(JSON.stringify(o.fulfillments));
            o.fulfillments = fulfillments.map(f => f.id);
            return fulfillments;
        });

        // Attach fulfillment events here via GQL
        let fulfillmentChunks = fulfillmentData
            .filter(f => !!f["admin_graphql_api_id"] && !!f["shipment_status"])
            .map(f => f["admin_graphql_api_id"])
            .chunk(250);

        for (let gidArray of fulfillmentChunks) {
            let fulfillmentEventData = await this.shopify.getFulfillmentEvents(gidArray);
            fulfillmentEventData.forEach(f => fulfillmentData.find(fulfillment => f.gid === fulfillment["admin_graphql_api_id"]).events = f.events);
        }

        await Promise.all([
            this.db.recordFreshDataChunk('orders', [...dateStepOrders, ...orderUpdates]),
            this.db.recordFreshDataChunk('fulfillments', [...fulfillmentData])
        ]);

        return {orders: [...dateStepOrders, ...orderUpdates], fulfillments: [...fulfillmentData]};
    }

    /**
     *  Gets recently updated customers using /customers.json?updated_at...
     *  Walks back in time to eventually read all customers.
     */
    async generateCustomerTasks(events) {
        let recentInterval = this._getRecentDateRange();
        let customerUpdates = await this.shopify.getCustomersByUpdatedDate(recentInterval.from, recentInterval.to);

        let dateStepCustomers = [];
        let currentDayStep = this._metadata.step;
        if (!this._metadata.shop.max_steps || currentDayStep <= this._metadata.shop.max_steps) {
            let from = new Date().minusDays(currentDayStep);
            let to = new Date().minusDays(currentDayStep - 1);
            dateStepCustomers = await this.shopify.getCustomersByDate(from, to);
        }

        await this.db.recordFreshDataChunk('customers', [...dateStepCustomers, ...customerUpdates]);
        return {customers: [...dateStepCustomers, ...customerUpdates]};
    }

    /**
     *  Uses events to read recently updated products.
     *  Walks back in time to eventually read all products.
     */
    async generateProductTasks(events) {

        let updatedProductIds = events.filter(ev => ev["subject_type"] === "Product").map(ev => ev["subject_id"]);
        let productUpdates = await this.shopify.getProductsById(updatedProductIds);

        let dateStepProducts = [];
        let currentDayStep = this._metadata.step;
        if (!this._metadata.shop.max_steps || currentDayStep <= this._metadata.shop.max_steps) {
            let from = new Date().minusDays(currentDayStep);
            let to = new Date().minusDays(currentDayStep - 1);
            dateStepProducts = await this.shopify.getProductsByDate(from, to);
        }

        await this.db.recordFreshDataChunk('products', [...dateStepProducts, ...productUpdates]);
        return {products: [...dateStepProducts, ...productUpdates]};
    }


    /**
     *  Gets recently updated discounts using ?updated_at...
     *  Walks back in time to eventually read all discounts.
     */
    async generateDiscountTasks(events) {
        let recentInterval = this._getRecentDateRange();
        let discountUpdates = await this.shopify.getPriceRulesByUpdatedDate(recentInterval.from, recentInterval.to);

        let dateStepDiscounts = [];
        let currentDayStep = this._metadata.step;
        if (!this._metadata.shop.max_steps || currentDayStep <= this._metadata.shop.max_steps) {
            let from = new Date().minusDays(currentDayStep);
            let to = new Date().minusDays(currentDayStep - 1);
            dateStepDiscounts = await this.shopify.getPriceRulesByDate(from, to);
        }

        await this.db.recordFreshDataChunk('discounts', [...dateStepDiscounts, ...discountUpdates]);
        return {discounts: [...dateStepDiscounts, ...discountUpdates]};
    }

    /**
     *  Same issue as with fulfillments
     */
    async generateInventoryTasks(products) {
        let inventoryItems = [];
        for (let chunk of products.flatMap(p => p.variants).chunk(100).chunk(4)) {
            await Promise.all(chunk.map(async idBlock => inventoryItems.push(await this.shopify.getInventoryItems(idBlock.map(v => v.inventory_item_id)))));
        }
        inventoryItems = inventoryItems.flatMap(r => r);
        await this.db.recordFreshDataChunk('inventory', inventoryItems);
        return {inventory: inventoryItems};
    }

    /**
     *  Reads shop.json
     */
    async updateShopInfo() {
        let shop = await this.shopify.getShop();
        if (!shop) {
            this._log("Failed to retrieve shop information");
            return false;
        }
        let shopCreated = new Date(shop.created_at);
        this._metadata.shop.max_steps = Math.ceil((new Date().getTime() - shopCreated.getTime()) / 8.64e7);
        this._metadata.shop.data = shop;
        return shop;
    }

    async _calculateResourceUsage() {
        this._metadata.lastStatusTime = new Date().getTime();
        this._metadata.dataObjectCounts = await this.db.countIndicesByType();
        this._metadata.dataObjectCount = Object.values(this._metadata.dataObjectCounts).reduce((count, typeCount) => count += typeCount, 0);
        this._metadata.dataFileCounts = await this.db.countDataFilesByType();
        this._metadata.dataFileCount = Object.values(this._metadata.dataFileCounts).reduce((count, v) => count += v, 0);
        // This is a measure of how much data is in each file versus gc_datapile_size. >1 = average file has less that gc_datapile_size objects
        this._metadata.f_factor = this._metadata.dataFileCount > 100 ? this.appconfig.general.gc_datapile_size / (this._metadata.dataObjectCount / (this._metadata.dataFileCount + 1 - this.db.datatypes.length)) : 0;
        this._metadata.disk_usage = this.db.calculateDiskUsage();
    }

    async _sendLogs() {
        if (this.disconnect) return;
        this.taskStatus.shop = await this.updateShopInfo();
        // If step read is finished, these values change much less frequently
        if (!this._metadata.lastStatusTime || this._metadata.lastStatusTime <= new Date().minusMinutes(10).getTime() || this._metadata.shop.max_steps >= this._metadata.step) {
            await this._calculateResourceUsage();
        }

        // Report status to console and/or log.txt
        this._log(`${this.store.name} is storing ${this._metadata.dataObjectCount} objects across ${this._metadata.dataFileCount} files (${this._metadata.f_factor.toFixed(2)}F). Step: ${this._metadata.step} / ${this._metadata.shop.max_steps}`);

        // Report task status to worker.js
        this._generateStatusReport();
        if (this.disconnect) return;
        this.statusCb(this.taskStatus);
    }

    _generateStatusReport() {
        this.taskStatus.properties = [
            {
                label: 'orders',
                combination_type: 'sum',
                format_type: 'group',
                value: this._metadata.dataObjectCounts.orders,
                unit: null
            },
            {
                label: 'fulfillments',
                combination_type: 'sum',
                format_type: 'group',
                value: this._metadata.dataObjectCounts.fulfillments,
                unit: null
            },
            {
                label: 'customers',
                combination_type: 'sum',
                format_type: 'group',
                value: this._metadata.dataObjectCounts.customers,
                unit: null
            },
            {
                label: 'products',
                combination_type: 'sum',
                format_type: 'group',
                value: this._metadata.dataObjectCounts.products,
                unit: null
            },
            {
                label: 'discounts',
                combination_type: 'sum',
                format_type: 'group',
                value: this._metadata.dataObjectCounts.discounts,
                unit: null
            },
            {
                label: 'sync state',
                combination_type: 'average',
                format_type: 'round',
                value: 100 * (this._metadata.step / (this._metadata.shop.max_steps + 1)),
                unit: "%"
            },
            {
                label: 'inventory items',
                combination_type: 'sum',
                format_type: 'group',
                value: this._metadata.dataObjectCounts.inventory,
                unit: null
            },
            {
                label: 'files',
                combination_type: 'sum',
                format_type: 'group',
                value: this._metadata.dataFileCount,
                unit: null
            },
            {
                label: 'total objects',
                combination_type: 'sum',
                format_type: 'group',
                value: this._metadata.dataObjectCount,
                unit: null
            },
            {
                label: 'disk usage',
                combination_type: 'sum',
                format_type: 'data',
                value: this._metadata.disk_usage,
                unit: null
            },
            {
                label: 'token usage',
                combination_type: 'average',
                format_type: 'round',
                value: this.shopify.token_monitoring.quantify_usage(),
                unit: "%"
            }
        ];
    }

    /**
     *  Records to disk information about read/write state
     */
    _writeMetadata() {
        this._fs.writeFileSync(this._getMetadataUrl(), JSON.stringify(this._metadata));
    }

    _readMetadata() {
        let metadataString = this._fs.readFileSync(this._getMetadataUrl(), {encoding: 'utf8'});
        return JSON.parse(metadataString);
    }

    _metadataExists() {
        return this._fs.existsSync(this._getMetadataUrl());
    }

    _getMetadataUrl() {
        return path.join(app.getPath('userData'), `./data/files/${this.store.name}-task-metadata-${this.store.uuid}.json`);
    }

    /**
     *  We want to find all objects updated since the last successful read took place.
     *  If the application was not running for a long period (>day), this read could take a long time.
     *  To prevent excessive read times, we want to chunk this time.
     */
    _getRecentDateRange() {
        if (new Date().getTime() - this._metadata.recent_read_cursor > 8.64e7) return {
            from: new Date(this._metadata.recent_read_cursor),
            to: new Date(this._metadata.recent_read_cursor).plusDays(1)
        };
        else return {from: new Date(this._metadata.recent_read_cursor).minusMinutes(1), to: new Date()};
    }

    _getLogFileUrl() {
        return path.join(app.getPath('userData'), `./data/log-${this.store.name}-${this.store.uuid}.txt`);
    }

    _log(message) {
        let logFileUrl = path.join(app.getPath('userData'), `./data/log-${this.store.name}-${this.store.uuid}.txt`);
        if (this.appconfig.logging.report_logs_to_console) console.log(message);
        if (!this._fs.existsSync(path.join(app.getPath('userData'), `./data`))) {
            this._fs.mkdirSync(path.join(app.getPath('userData'), `./data`));
        }
        if (!this._fs.existsSync(logFileUrl)) {
            this._fs.writeFileSync(logFileUrl, `${message}\n`);
        } else {
            let stream = this._fs.createWriteStream(logFileUrl, {flags: 'a'});
            stream.write(`${message}\n`);
            stream.end();
        }
        // Delete everything but the last 3k lines of the file
        let size = this._fs.statSync(logFileUrl).size;
        if (size > (3 * 1024 * 1024)) {
            let fileLines = this._fs.readFileSync(logFileUrl, {encoding: 'utf8'}).split('\n');
            fileLines.splice(0, fileLines.length - 3001);
            this._fs.writeFileSync(logFileUrl, fileLines.join('\n'));
        }
    }
}

exports.DataTask = DataTaskManager;