/**
 * Provides access to app-config for both view and worker
 * Runs on main, interfaces via IPC
 */

class AppController {
    constructor() {
        this._fs = require('fs');
        this._uuid = require('uuid');
        this._axios = require('axios');
        this.config = this._readConfig();
        this.stores = this.config.stores;
    }

    async registerStore({name, key, password, url}) {
        let shopData = await this._axios(`https://${key}:${password}@${url}/admin/api/2020-10/shop.json`);
        let plus = shopData.data.shop.plan_name === "shopify_plus";

        let data = arguments[0];
        data.registered_at = new Date().getTime();
        data.uuid = this._uuid.v4();
        data.plus = plus;

        this.stores.push(data);
        this._writeConfig();
        return data;
    }

    deregisterStore(uuid) {
        this.config.stores = this.config.stores.filter(s => s.uuid !== uuid);
        this.stores = this.config.stores;
        this._writeConfig();
    }

    _writeConfig() {
        this._fs.writeFileSync('./app-config.json', JSON.stringify(this.config));
    }

    _readConfig() {
        if (this._fs.existsSync('./app-config.json')) return JSON.parse(this._fs.readFileSync('./app-config.json', {encoding: 'utf8'}));
        else return {
            "general": {
                "no_data_threshold": 6,
                "no_data_default_sleep": 5000,
                "minimum_duration": 2000,
                "gc_datapile_size": 500,
                "sync_frequency": 259200000
            },
            "logging": {
                "report_logs_to_console": true,
                "report_network_logs": false
            },
            "queries": {
                "cache_ttl": 3e5,
                "use_caching": true,
                "automatic_result_view": false
            },
            "stores": []
        }
    }
}

exports.AppController = AppController;