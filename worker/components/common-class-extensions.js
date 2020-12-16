/**
 * These are extensions to commonly-used classes.
 * We'd like these methods to be available across our app,
 * so this file should be included @index.js
 */

Array.prototype.none = function (q) {
    return !this.some(q);
}

Array.prototype.existentialEvery = function (q) {
    return this.length !== 0 && this.every(q);
}

Date.prototype.minusMinutes = function (n) {
    let dateCopy = new Date(this.getTime());
    return new Date(dateCopy.setMinutes(this.getMinutes() - n));
};

Date.prototype.plusMinutes = function (n) {
    let dateCopy = new Date(this.getTime());
    return new Date(dateCopy.setMinutes(this.getMinutes() + n));
};

Date.prototype.minusDays = function (n) {
    let dateCopy = new Date(this.getTime());
    return new Date(dateCopy.setDate(this.getDate() - n));
};

Date.prototype.plusDays = function (n) {
    let dateCopy = new Date(this.getTime());
    return new Date(dateCopy.setDate(this.getDate() + n));
};

Date.prototype.toShopifyString = function () {
    return this.toISOString();
};
/**
 *  Chunks array according to provided map.
 *  idMap: {this[n]: id}
 *  Lazily ensures that chunks do not share IDs
 */
Array.prototype.pureChunk = function (chunkSize, idMap) {
    let sortedArray = this.sort((a, b) => {
        if (idMap[a] > idMap[b]) return 1;
        else if (idMap[a] < idMap[b]) return -1;
        else return 0;
    });
    let proposedChunks = sortedArray.reduce((acc, curr) => {
        let currentChunk = acc[acc.length - 1] || [];
        let currentChunkIdSet = Array.from(new Set(currentChunk.map(d => idMap[d])));
        if (currentChunk.length < chunkSize || currentChunkIdSet.includes(idMap[curr])) currentChunk.push(curr);
        else acc.push([curr]);
        return acc;
    }, [[]]);
    if (proposedChunks[0].length === 0) return [];
    else return proposedChunks;
};

Array.prototype.chunk = function (chunkSize) {
    let proposedChunks = this.reduce((acc, curr) => {
        let currentChunk = acc[acc.length - 1] || [];
        if (currentChunk.length < chunkSize) currentChunk.push(curr);
        else acc.push([curr]);
        return acc;
    }, [[]]);
    if (proposedChunks[0].length === 0) return [];
    else return proposedChunks;
};