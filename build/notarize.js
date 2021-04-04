const path = require('path');
const electron_notarize = require('electron-notarize');

module.exports = async function (params) {
    // Only notarize the app on Mac OS only.
    if (process.platform !== 'darwin') {
        return;
    }
    console.log('Notarization requested:', params);

    // Same appId in electron-builder.
    let appId = 'ShopDatabaser'

    let appPath = path.join(params.appOutDir, `${params.packager.appInfo.productFilename}.app`);

    console.log(`Notarizing ${appId} found at ${appPath}`);

    try {
        await electron_notarize.notarize({
            appBundleId: appId,
            appPath: appPath,
            appleId: '@keychain:SD_USERNAME',
            appleIdPassword: '@keychain:SD_PASSWORD',
        });
    } catch (error) {
        console.error(error);
    }

    console.log(`Done notarizing ${appId}`);
};