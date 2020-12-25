const path = require('path');
require(path.join(__dirname, '../worker/components/common-class-extensions'));
const {ipcRenderer, shell} = require('electron');
ipcRenderer.on('reload', () => window.location.reload());
let show = (type) => {
    Array.from(document.querySelectorAll('.navigation .tab,.content')).forEach(el => el.classList.remove('active'));
    Array.from(document.querySelectorAll(`.tab.${type},.content.${type}`)).forEach(el => el.classList.add('active'));
};

class Status {
    constructor() {
        this.updateCallbacks = [];
        this.reports = {};
        ipcRenderer.invoke('get-status');

        this.statusReady = new Promise(ready => {
            ipcRenderer.on('status', (event, status) => {
                this.reports[status.store.uuid] = status;
                this.drawStatusTiles();
                this.updateCallbacks.forEach(cb => cb(this.reports));
                ready();
            });
        });
    }

    async ready() {
        return this.statusReady;
    }

    static toDisplayValue(prop) {
        let displayValue, unit = prop.unit;
        if (prop.format_type === 'group') {
            displayValue = prop.value.toLocaleString('en', {useGrouping: true});
        } else if (prop.format_type === 'round') {
            displayValue = prop.value.toFixed(0);
        } else if (prop.format_type === 'data') {
            let B_string = prop.value.toFixed(0);
            let kB_string = (prop.value / (1024)).toFixed(0);
            let MB_string = (prop.value / (1024 * 1024)).toFixed(0);
            let GB_string = (prop.value / (1024 * 1024 * 1024)).toFixed(0);
            if (B_string.length < 4) {
                displayValue = B_string;
                unit = " B";
            } else if (kB_string.length < 4) {
                displayValue = kB_string;
                unit = " kB";
            } else if (MB_string.length < 4) {
                displayValue = MB_string;
                unit = " MB";
            } else {
                displayValue = GB_string;
                unit = " GB";
            }
        } else displayValue = prop.value;
        if (unit) displayValue += unit;
        return displayValue;
    }

    getDisplayProperty(store, prop_label) {
        let report = this.reports[store.uuid];
        let prop = report.properties.find(p => p.label === prop_label);
        return Status.toDisplayValue(prop);
    }

    drawStatusTiles() {
        let cumulativeProps = [];
        Object.keys(this.reports).forEach(id => {
            let report = this.reports[id];
            let props = report.properties;
            props.filter(p => p.combination_type === 'sum').forEach(p => {
                cumulativeProps.find(c => c.label === p.label) ? cumulativeProps.find(c => c.label === p.label).value += +p.value : cumulativeProps.push({...p});
            });
            props.filter(p => p.combination_type === 'average').forEach(p => {
                if (cumulativeProps.find(c => c.label === p.label)) {
                    cumulativeProps.find(c => c.label === p.label).value += +p.value;
                    cumulativeProps.find(c => c.label === p.label).n++;
                } else cumulativeProps.push({...p, n: 1});
            });
            cumulativeProps.filter(p => p.combination_type === 'average').forEach(c => c.value = (c.value / c.n));
        });
        cumulativeProps.push({
            value: Object.keys(this.reports).length,
            label: "stores"
        })
        let newTilesHtml = cumulativeProps.reduce((tiles, c) => tiles += this.createStatusTile(Status.toDisplayValue(c), c.label), '');
        document.querySelector('.content.status .tiles').innerHTML = newTilesHtml;
    }

    createStatusTile(value, label) {
        return `
            <div class="tile">
                <div>${value}</div>
                <span>${label}</span>            
            </div>
        `;
    }

    addListener(callback) {
        this.updateCallbacks.push(callback);
    }
}

class Stores {
    constructor() {
        ipcRenderer.invoke('get-stores').then(stores => {
            if (stores.length === 0) {
                this.display(stores);
                show('stores');
            }
        });
        app.status.ready().then(r => {
            ipcRenderer.invoke('get-stores').then(stores => {
                this.stores = stores;
                this.display(stores);
            });
        });
    }

    display(stores) {
        if (!stores) stores = this.stores;
        document.querySelector('.store-list > div').innerHTML = [...stores.map(s => this.createStoreRow(s)), this.createAddStoreRow()].join('\n');
    }

    createAddStoreRow() {
        return `
            <div class="store">
                <a style="margin: 0 auto;" onclick="app.stores.addStore()">Add a store</a>
            </div>
        `;
    }

    createStoreRow(store) {
        app.status.addListener((reports) => {
            let shop = null, disk_usage = "-", token_usage = "-";
            if (reports[store.uuid]) {
                shop = reports[store.uuid].shop;
                disk_usage = app.status.getDisplayProperty(store, 'disk usage');
                token_usage = app.status.getDisplayProperty(store, 'token usage');
            }
            let storeIndicator = document.querySelector(`.store[data-store='${store.uuid}'] .indicator`);
            if (shop) storeIndicator.classList.add('good');
            else storeIndicator.classList.remove('good');
            storeIndicator.title = `Token: ${token_usage} / Disk: ${disk_usage}`;
        });
        return `
            <div class="store" data-store="${store.uuid}">
                <div class="store-left">
                    <span class="store-title"><span class="indicator good">&nbsp;</span>${store.name} - ${store.plus ? "Plus" : "Basic"}</span>
                    <span>${store.url}</span>
                    <a href="https://${store.url}/admin" target="_blank">Open store admin</a>
                </div>
                <div class="store-right">
                    <a onclick="shell.openPath(path.join(app.getPath('userData'), './data'))">View logs</a>
                    <a onclick="app.stores.confirmSync('${store.uuid}')">Force re-sync</a>
                    <a onclick="app.stores.confirmDisconnect('${store.uuid}')">Disconnect store</a>
                </div>
            </div>
        `;
    }

    addStore() {
        ipcRenderer.invoke('add-store');
    }

    confirmSync(id) {
        let store = this.stores.find(s => s.uuid === id);
        ipcRenderer.invoke('confirm-resync-store', store);
    }

    confirmDisconnect(id) {
        let store = this.stores.find(s => s.uuid === id);
        let disk_usage = app.status.getDisplayProperty(store, 'disk usage');
        ipcRenderer.invoke('confirm-disconnect-store', {disk_usage: disk_usage, ...store}).then(confirmed => {
            if (confirmed) setTimeout(window.location.reload(), 0);
        });
    }
}

class Queries {
    constructor() {
        let {Database} = require(path.resolve(path.join(__dirname, '../worker/components/database.js')));
        ipcRenderer.invoke('get-stores').then(stores => {
            ipcRenderer.invoke('get-config').then(appconfig => {
                this.interfaces = stores.map(store => new Database(store, appconfig).queryMode());
            });
        });
        window.addEventListener('DOMContentLoaded', () => {
            ipcRenderer.invoke('get-stores').then(stores => {
                stores.forEach((store, index) => {
                    let option = document.createElement('option');
                    if (index === 0) option.setAttribute('selected', 'true');
                    option.innerText = store.name;
                    option.setAttribute('value', store.uuid);
                    document.querySelector('.query-container > select').appendChild(option);
                });
            });
            document.querySelector('.query-container > textarea').addEventListener('keydown', (ev) => {
                if ((ev.code === "Enter" || ev.code === "NumpadEnter") && !ev.shiftKey) {
                    ev.preventDefault();
                    return false;
                }
            });
            document.querySelector('.query-container > .query-submit').addEventListener('click', () => {
                let uuid = document.querySelector('.query-container > select').value;
                if (document.querySelector('.query-container > textarea').value !== "") this.handle(document.querySelector('.query-container > textarea').value, uuid);
            });
            document.querySelector('.query-container > textarea').addEventListener('input', (ev) => {
                // Dynamically adjust textarea height
                ev.currentTarget.style.height = "18px";
                ev.currentTarget.style.height = `${ev.currentTarget.scrollHeight}px`;
                // Format query input to look nicer
                if (app.settings.queries.pretty_print) {
                    ev.currentTarget.value = ev.currentTarget.value.replace(/([\:\[\]=~><&!\w])([\:\[\]=~><&!])$/g, '$1 $2 ');
                    ev.currentTarget.value = ev.currentTarget.value.replace(/([\:\[\]=~><&!])(\w)/g, '$1 $2');
                    ev.currentTarget.value = ev.currentTarget.value.replace(/([><])\s(=)/g, '$1$2 ');
                }
            });
            document.querySelector('.query-container > textarea').addEventListener('keydown', (ev) => {
                if (ev.code === "Enter" && !ev.shiftKey && !ev.ctrlKey) {
                    let uuid = document.querySelector('.query-container > select').value;
                    if (ev.currentTarget.value !== "") this.handle(ev.currentTarget.value, uuid);
                }
            });
            document.querySelector('.send-to-file').addEventListener('click', () => {
                if (this.results) this.saveToFile();
            });
            document.querySelector('.send-to-console').addEventListener('click', () => {
                if (this.results) this.viewResults();
            });
        });
    }

    viewResults() {
        ipcRenderer.invoke('new-terminal').then(() => {
            let chunks = this.results.data.chunk(2500);
            for (let i = 0; i < chunks.length; i++) {
                ipcRenderer.invoke('terminal-data-chunk', {
                    chunk: chunks[i],
                    step: i + 1,
                    max: chunks.length,
                    store: this.results.store,
                    query: this.results.query
                });
            }
        });
    }

    saveToFile() {
        ipcRenderer.invoke('save-json').then(async path => {
            if (path) {
                let abort = false;
                ipcRenderer.on('abort-save', () => abort = true);
                let fs = require('fs');
                let properPath = `${path.replace('.json', '')}.json`;
                let writeStream = fs.createWriteStream(properPath);
                let chunks = this.results.data.chunk(1000);
                writeStream.write('[');
                let yieldThread = () => {
                    return new Promise(r => setTimeout(r, 0));
                };
                for (let i = 0; i < chunks.length; i++) {
                    await yieldThread(); // We need an async operation in the loop so the 'abort-save' listener has an opportunity to execute
                    if (abort) {
                        writeStream.end();
                        fs.unlinkSync(properPath);
                        break;
                    }
                    let chunkString = JSON.stringify(chunks[i]); // All of this code is here to facilitate this -- JSON.stringify dominates the thread for large inputs (or fails entirely)
                    chunkString = chunkString.substring(1, chunkString.length - 1); // Remove brackets
                    if (i < chunks.length - 1) chunkString += ','; // Add comma for next chunk
                    writeStream.write(chunkString);
                    if (i === chunks.length - 1) {
                        writeStream.write(']');
                        writeStream.end();
                    }
                }
                if (abort === false) ipcRenderer.invoke('modal-close-window', false);
            }
        });
    }

    handle(q, uuid) {
        document.querySelector('.query-status').innerText = "Running...";
        let db = this.interfaces.find(db => db.store.uuid === uuid);
        db.query(q).then(result => {
            this.results = null;
            document.querySelector('.query-status').innerHTML = result.message;
            this.results = result;
            if (app.settings.queries.automatic_result_view) this.viewResults();
            document.querySelector('div.query-results').parentNode.replaceChild(document.querySelector('div.query-results').cloneNode(), document.querySelector('div.query-results'));
            this.renderRows(this.results);
        });
    }

    // Lesson learned (hopefully) -- technical users will go straight to console, nontechnical users don't want to read json
    // Give basic md rows for nontechnical users
    // Each data type gets up to 7 fields to display
    renderRows(queryResult, n) {
        let renderLimit = 25;
        let renderCursor = n || 0;
        let fields = [];
        let resultSegment = queryResult.data.slice(renderCursor * renderLimit, (renderCursor + 1) * renderLimit);
        if (queryResult.type === "orders") fields = resultSegment.map(this._formatOrder);
        else if (queryResult.type === "fulfillments") fields = resultSegment.map(this._formatFulfillment);
        else if (queryResult.type === "customers") fields = resultSegment.map(this._formatCustomer);
        else if (queryResult.type === "products") fields = resultSegment.map(this._formatProduct);
        else if (queryResult.type === "discounts") fields = resultSegment.map(this._formatDiscount);
        else if (queryResult.type === "inventory") fields = resultSegment.map(this._formatInventory);

        document.querySelector('div.query-results').innerHTML += fields.reduce((html, fieldSet) => html += this._createRow(`https://${queryResult.store.url}${fieldSet.pop()}`, fieldSet), '');
        let scrollHandled = false;
        let scrollHandler = (ev) => {
            if (scrollHandled) return;
            let percentScrolled = ev.target.scrollTop / (ev.target.scrollHeight - ev.target.clientHeight);
            if (percentScrolled > 0.7) {
                scrollHandled = true;
                ev.target.removeEventListener('scroll', scrollHandler);
                if (queryResult.data.slice(renderCursor * renderLimit, (renderCursor + 1) * renderLimit).length > 0) this.renderRows(queryResult, renderCursor + 1);
            }
        };
        document.querySelector('div.query-results').addEventListener('scroll', scrollHandler, {passive: true});
    }

    _formatOrder(order) {
        return [
            order.name,
            `${order.financial_status} / ${order.fulfillment_status ? order.fulfillment_status : "unfulfilled"}`,
            `$${order.total_price_usd}`,
            order.line_items[0] ? order.line_items[0].title : '',
            order.line_items[1] ? order.line_items[1].title : '',
            order.line_items[2] ? order.line_items[3] ? `${order.line_items.length - 2} more...` : order.line_items[2].title : '',
            new Date(order.created_at).toDateString(),
            `/admin/orders/${order.id}`
        ];
    }

    _formatFulfillment(fulfillment) {
        return [
            fulfillment.name,
            fulfillment.tracking_company,
            fulfillment.events ? fulfillment.events.length > 0 ? fulfillment.events[fulfillment.events.length - 1].status : "No tracking updates" : "No tracking updates",
            fulfillment.line_items[0] ? fulfillment.line_items[0].title : '',
            fulfillment.line_items[1] ? fulfillment.line_items[1].title : '',
            fulfillment.line_items[2] ? fulfillment.line_items[3] ? `${fulfillment.line_items.length - 2} more...` : fulfillment.line_items[2].title : '',
            new Date(fulfillment.created_at).toDateString(),
            `/admin/orders/${fulfillment.order_id}`
        ];
    }

    _formatCustomer(customer) {
        return [
            `${customer.first_name} ${customer.last_name}`,
            `$${customer.total_spent}`,
            `${customer.orders_count} order${customer.orders_count === 1 ? '' : 's'}`,
            customer.default_address ? customer.default_address.country_name : 'No addresses saved',
            '',
            '',
            new Date(customer.created_at).toDateString(),
            `/admin/customers/${customer.id}`
        ];
    }

    _formatProduct(product) {
        return [
            product.title,
            `${product.variants.length} variant${product.variants.length === 1 ? '' : 's'}`,
            '',
            `Vendor: ${product.vendor}`,
            `Type: ${product.product_type}`,
            '',
            new Date(product.created_at).toDateString(),
            `/admin/products/${product.id}`
        ];
    }

    _formatDiscount(discount) {
        return [
            discount.title,
            `${discount.value}${discount.value_type === "percentage" ? "%" : "$"}`,
            '',
            discount.prerequisite_customer_ids.length > 0 ? 'Specific customers' : 'Any customer',
            discount.prerequisite_product_ids.length > 0 || discount.prerequisite_variant_ids.length > 0 ? 'Specific products' : 'Any product',
            '',
            new Date(discount.created_at).toDateString(),
            `/admin/discounts/${discount.id}`
        ];
    }

    _formatInventory(inventory) {
        return [
            inventory.sku,
            inventory.tracked ? "Inventory tracked" : "Untracked",
            inventory.requires_shipping ? "Physical product" : "Non-physical product",
            `$${inventory.cost} cost`,
            `HTS ${inventory.harmonized_system_code}`,
            '',
            new Date(inventory.created_at).toDateString(),
            ''
        ];
    }

    _createRow(url, fields) {
        return `<a class="result-line" href="${url}" target="_blank">
                    <div>
                        <span class="result-identifier">${fields[0]}</span>
                        <span>${fields[1]}</span>
                        <span>${fields[2]}</span>
                    </div>
                    <div>
                        <span>${fields[3]}</span>
                        <span>${fields[4]}</span>
                        <span>${fields[5]}</span>
                    </div>
                    <div>
                        <span>${fields[6]}</span>
                    </div>
                </a>`
    }
}

class Settings {
    constructor() {
        ipcRenderer.invoke('get-config').then(appconfig => {
            Object.assign(this, appconfig);
            this.getInput('sync_frequency').value = appconfig.general.sync_frequency / 8.64e7;
            this.getInput('sync_frequency').addEventListener('blur', (ev) => {
                if (ev.currentTarget.value * 8.64e7 !== app.settings.general.sync_frequency) {
                    ipcRenderer.invoke('update-config', {
                        type: 'general',
                        key: 'sync_frequency',
                        value: ev.currentTarget.value * 8.64e7
                    });
                }
            });

            this.getInput('cache_ttl').value = appconfig.queries.cache_ttl / 6e4;
            this.getInput('cache_ttl').addEventListener('blur', (ev) => {
                if (ev.currentTarget.value * 6e4 !== app.settings.queries.cache_ttl) {
                    ipcRenderer.invoke('update-config', {
                        type: 'queries',
                        key: 'cache_ttl',
                        value: ev.currentTarget.value * 6e4
                    });
                }
            });

            this.getInput('use_caching').checked = appconfig.queries.use_caching;
            this.getInput('use_caching').addEventListener('change', (ev) => {
                if (ev.currentTarget.value !== app.settings.queries.use_caching) {
                    ipcRenderer.invoke('update-config', {
                        type: 'queries',
                        key: 'use_caching',
                        value: JSON.parse(ev.currentTarget.checked)
                    });
                }
            });

            this.getInput('automatic_result_view').checked = appconfig.queries.automatic_result_view;
            this.getInput('automatic_result_view').addEventListener('change', (ev) => {
                if (ev.currentTarget.value !== app.settings.queries.automatic_result_view) {
                    ipcRenderer.invoke('update-config', {
                        type: 'queries',
                        key: 'automatic_result_view',
                        value: JSON.parse(ev.currentTarget.checked)
                    });
                }
            });

            this.getInput('pretty_print').checked = appconfig.queries.pretty_print;
            this.getInput('pretty_print').addEventListener('change', (ev) => {
                if (ev.currentTarget.value !== app.settings.queries.pretty_print) {
                    ipcRenderer.invoke('update-config', {
                        type: 'queries',
                        key: 'pretty_print',
                        value: JSON.parse(ev.currentTarget.checked)
                    });
                }
            });
        })
    }
    getInput(name) {
        return document.querySelector(`.settings input[name="${name}"]`);
    }
}

window.app = {};
window.app.status = new Status();
window.app.stores = new Stores();
window.app.queries = new Queries();
window.app.settings = new Settings();
(()=>{
    let electron = require('electron');
    app.getPath = electron.remote.app.getPath;
})();
ipcRenderer.on('config-update', (ev, c) => {
    Object.assign(window.app.settings, c);
    window.app.queries.interfaces.forEach(i => i.appconfig = c);
});