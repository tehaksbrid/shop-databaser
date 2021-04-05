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
        this._fs.writeFileSync(path.join(app.getPath('userData'), `./app-config.json`), JSON.stringify(this.config));
    }

    _readConfig() {
        if (this._fs.existsSync(path.join(app.getPath('userData'), `./app-config.json`))) return JSON.parse(this._fs.readFileSync(path.join(app.getPath('userData'), `./app-config.json`), {encoding: 'utf8'}));
        else return {
            "general": {
                "no_data_threshold": 6,
                "no_data_default_sleep": 5000,
                "minimum_duration": 2000,
                "gc_datapile_size": 500,
                "sync_frequency": 8.64e8
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

const path = require('path');
const {Menu, Tray, app, BrowserWindow, ipcMain, shell, dialog} = require('electron');
const electron_is_dev = require('electron-is-dev');
const controller = new AppController();
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) return app.quit();
/**
 * Setup and open windows
 */
let view, worker, tray, trueQuit = false;
app.whenReady().then(() => {
    view = new BrowserWindow({
        width: 800,
        height: 600,
        frame: false,
        icon: path.join(__dirname, './view/assets/icons/icon.png'),
        webPreferences: {
            nodeIntegration: true,
            enableRemoteModule: true
        }
    })
    if (electron_is_dev) view.webContents.openDevTools();
    view.webContents.on('new-window', (e, url) => {
        e.preventDefault();
        shell.openExternal(url);
    });
    view.loadFile(path.join(__dirname, './view/view.html'));

    view.on('minimize', function (event) {
        event.preventDefault();
        view.hide();
        return false;
    });

    view.on('close', function (event) {
        if (trueQuit === true) return true;
        event.preventDefault();
        view.hide();
        return false;
    });

    tray = new Tray(path.join(__dirname, process.platform === "darwin" ? './view/assets/icons/icon32@2x.png' : './view/assets/icons/icon.png'));
    let contextMenu = Menu.buildFromTemplate([
        {
            label: 'Close application', click: () => {
                trueQuit = true;
                worker.close();
                view.close();
                tray.destroy();
                worker = null;
                view = null;
                tray = null;
            }
        }
    ]);
    tray.on('click', () => {
        view.show();
    });
    tray.setToolTip('Shop Databaser');
    tray.setContextMenu(contextMenu);

    worker = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: true,
            enableRemoteModule: true
        }
    });
    if (electron_is_dev) worker.webContents.openDevTools();
    worker.loadFile(path.join(__dirname, 'worker/worker.html'));
});

app.on('window-all-closed', () => {
    if (trueQuit === true) {
        app.quit()
    }
});

app.on('second-instance', () => {
    view.show();
    view.focus();
});

app.on('activate', (ev, hasWindow) => {
    if (!hasWindow) view.show();
});

/**
 * IPCs
 */

/**
 *  View is requesting a new thread to display query results in
 */
ipcMain.handle('new-terminal', async () => {
    ipcMain.removeHandler('terminal-data-chunk');
    let consoleParent = new BrowserWindow({
        show: false,
        frame: false,
        webPreferences: {nodeIntegration: true}
    });
    await consoleParent.loadFile(path.join(__dirname, `./view/modals/result-viewer.html`));
    await new Promise(r => {
        consoleParent.once('ready-to-show', () => {
            consoleParent.webContents.openDevTools({mode: 'detach'});
            consoleParent.webContents.on('devtools-closed', () => {
                ipcMain.removeHandler('terminal-data-chunk');
                consoleParent.close();
            });
            r();
        });
    });
    ipcMain.handle('terminal-data-chunk', (event, data) => {
        consoleParent.webContents.send('console-load-data', data);
    });
    return;
});
/**
 *  View is requesting that the user select a location to save a json file
 */
ipcMain.handle('save-json', () => {
    let result = dialog.showSaveDialogSync(view, {
        title: 'Save query results to JSON file'
    });
    if (result) {
        ModalProvider.serveModal({
            width: 400,
            height: 150,
            parent: view,
            content: path.join(__dirname, './view/modals/save-json.html'),
            data: {
                path: result
            }
        }).then(aborted => {
            if (aborted) {
                view.webContents.send('abort-save');
            }
        });
    }
    return result;
});
/**
 *  View is requesting that we connect a new store. We do so via 'controller', then send reload requests to view+worker
 */
ipcMain.handle('add-store', () => {
    return ModalProvider.serveModal({
        width: 400,
        height: 300,
        parent: view,
        content: path.join(__dirname, './view/modals/add-store.html'),
    }).then(store => {
        if (store) {
            controller.registerStore(store).then(r => {
                worker.webContents.send('reload');
                view.webContents.send('reload');
            });
        }
    });
});
/**
 *  View is requesting that we disconnect a store. We show a modal for confirmation.
 */
ipcMain.handle('confirm-disconnect-store', (event, store) => {
    return ModalProvider.serveModal({
        width: 400,
        height: 160,
        parent: view,
        content: path.join(__dirname, './view/modals/confirm-disconnect.html'),
        data: {
            name: store.name,
            disk_usage: store.disk_usage
        }
    }).then(confirmed => {
        if (confirmed) {
            worker.webContents.send('deregister-store', store.uuid);
            controller.deregisterStore(store.uuid);
        }
        return confirmed;
    });
});
/**
 *  View is requesting that we re-sync a store. We show a modal for confirmation
 */
ipcMain.handle('confirm-resync-store', (event, store) => {
    return ModalProvider.serveModal({
        width: 400,
        height: 160,
        parent: view,
        content: path.join(__dirname, './view/modals/confirm-resync.html'),
        data: {
            name: store.name
        }
    }).then(confirmed => {
        if (confirmed) worker.webContents.send('force-resync', store.uuid);
        return confirmed;
    });
});
/**
 *  View/worker is requesting a list of currently-connected stores
 */
ipcMain.handle('get-stores', (event) => {
    return controller.stores || [];
});
/**
 *  View is explicitly requesting a status update
 */
ipcMain.handle('get-status', () => {
    worker.webContents.send('get-status');
});
/**
 *  View is sending a 'settings' update
 */
ipcMain.handle('update-config', (event, {type, key, value}) => {
    controller.config[type][key] = value;
    controller._writeConfig();
    view.webContents.send('config-update', controller.config);
    worker.webContents.send('config-update', controller.config);
});
/**
 *  View/worker is requesting appconfig
 */
ipcMain.handle('get-config', (event) => {
    return controller.config;
});
/**
 * data-task-manager will periodically send information about each task
 * This handler forwards that information to the view for display to the user
 */
ipcMain.handle('status', (event, status) => {
    view.webContents.send('status', status);
});

class ModalProvider {
    static async serveModal({width, height, parent, content, data}) {
        let modal = new BrowserWindow({
            width: width,
            height: height,
            parent: parent,
            modal: true,
            frame: false,
            webPreferences: {nodeIntegration: true}
        });
        modal.loadFile(path.join(__dirname, './view/modal-template.html'));
        modal.once('ready-to-show', () => {
            modal.webContents.send('modal-load-data', data);
            modal.webContents.send('modal-load-contents', content);
            modal.show();
        });
        modal.webContents.on('new-window', (e, url) => {
            e.preventDefault();
            shell.openExternal(url);
        });
        return new Promise(resolve => {
            ipcMain.handleOnce('modal-close-window', (event, returnValue) => {
                modal.close();
                resolve(returnValue);
            });
        });
    }
}