const {Menu, Tray, app, BrowserWindow, ipcMain, shell, dialog} = require('electron');
const {AppController} = require('./app-controller');
const path = require('path');
const controller = new AppController();

/**
 * Setup and open windows
 */
let view, worker, tray, trueQuit = false;
app.whenReady().then(() => {
    view = new BrowserWindow({
        width: 800,
        height: 600,
        frame: false,
        icon: path.resolve('./icon.png'),
        webPreferences: {
            nodeIntegration: true
        }
    })
    view.webContents.openDevTools();
    view.webContents.on('new-window', (e, url) => {
        e.preventDefault();
        shell.openExternal(url);
    });
    view.loadFile('view/view.html');

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

    tray = new Tray(path.resolve('./icon.png'));
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
        webPreferences: {nodeIntegration: true}
    });
    worker.webContents.openDevTools();
    worker.loadFile('worker/worker.html');
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || trueQuit === true) {
        app.quit()
    }
})

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
    await consoleParent.loadFile('./view/modals/result-viewer.html');
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
            content: './view/modals/save-json.html',
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
        content: './view/modals/add-store.html',
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
        content: './view/modals/confirm-disconnect.html',
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
        content: './view/modals/confirm-resync.html',
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
        modal.loadFile('./view/modal-template.html');
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