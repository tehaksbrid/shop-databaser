const path = require('path');
require(path.join(__dirname, './components/common-class-extensions'));
const {ipcRenderer} = require('electron');
const {DataTask} = require(path.join(__dirname, './components/data-task-manager'));
let receiveStatusReport = (report) => ipcRenderer.invoke('status', report);
ipcRenderer.on('reload', () => window.location.reload());
ipcRenderer.on('deregister-store', async (event, uuid) => {
    let task = tasks.find(t => t.store.uuid === uuid);
    task.disconnect = true;
    tasks = tasks.filter(t => t.store.uuid !== uuid);
});
ipcRenderer.on('force-resync', async (event, uuid) => {
    let task = tasks.find(t => t.store.uuid === uuid);
    await task.forceSync();
});
ipcRenderer.on('get-status', () => {
    tasks.forEach(task => {
        if (task.db.initialized) task._sendLogs().catch();
    });
});
let tasks = [];
(async () => {
    let stores = await ipcRenderer.invoke('get-stores');
    let config = await ipcRenderer.invoke('get-config');
    // noinspection ES6MissingAwait
    stores.forEach(async s => {
        let task = new DataTask(s, config, receiveStatusReport);
        tasks.push(task);
        await task.run();
    });
})();
ipcRenderer.on('config-update', (ev, c) => {
    tasks.forEach(t => t.updateConfig(c));
});
