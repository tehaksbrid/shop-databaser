// TODO -- some usages of FS are unnecessarily synchronous
/**
 * Represents the collective knowledge of a single Shopify store and provides interfaces for:
 *  -Loading and unloading data
 *  -Performing simple queries
 *
 * Immutable from the front-end.
 */
const path = require('path');
const {remote} = require('electron');
const app = remote.app;
class Database {
    constructor(store, appconfig, logger) {
        this.store = store;
        this._fs = require('fs');
        this._zlib = require('zlib');
        this._uuid = require('uuid');
        this.appconfig = appconfig;
        this.initialized = false;
        this._log = logger;
    }

    queryMode() {
        this._queryMode = true;
        this._cache = {
            has: (type) => !!this._cache._data[type],
            get: (type) => {
                clearTimeout(this._cache._data[type].ttl);
                this._cache._data[type].ttl = null;
                this._cache._data[type].ttl = setTimeout(() => {
                    delete this._cache._data[type];
                }, this.appconfig.queries.cache_ttl);
                return this._cache._data[type].data;
            },
            put: (type, data) => {
                this._cache._data[type] = {
                    ttl: setTimeout(() => {
                        delete this._cache._data[type];
                    }, this.appconfig.queries.cache_ttl),
                    data: data
                }
            },
            _data: {}
        }
        return this;
    }

    async initialize() {
        this._validateDirectories();
        this.indexFailure = await this._validateIndexHealth();
        await this._validateIndexContents();
        this.initialized = true;
    }

    async deleteAll() {
        let deleteIndices = this.datatypes.map(type => {
            let indexUrl = this._getIndexUrl(type);
            return new Promise(r => this._fs.unlink(indexUrl, r));
        });
        await Promise.all(deleteIndices);

        let dataFiles = this._fs.readdirSync(this._dataPath);
        let deleteDataFiles = dataFiles.map(file => new Promise(r => {
            this._fs.unlink(this._dataPath + '/' + file, r);
        }));
        await Promise.all(deleteDataFiles);

        this._fs.rmdirSync(this._dataPath);
        return;
    }

    /**
     * Tells the instance how to relate data types that are not stored together.
     * Syntactic sugar for resolving queries such as orders:fulfillments:line_items:product[product_type:value]
     * Example: Fulfillments have a many:one association with orders, but are stored separately.
     */
    _join({parents_type, parents, parent_path_to_child, children_type, children}) {
        let availableLinkages = {
            orders: {
                fulfillments: {parent_key: "id", child_key: "order_id", reversible: true},
                customers: {parent_key: "customer", child_key: "id"}
            },
            fulfillments: {
                orders: {parent_key: "order_id", child_key: "id"}
            },
            line_items: {
                products: {parent_key: "product_id", child_key: "id"}
            },
            customers: {
                orders: {parent_key: "id", child_key: "customer"}
            },
            variants: {
                inventory: {parent_key: "inventory_item_id", child_key: "id"}
            }
        };
        let relationship = availableLinkages[parents_type][children_type];
        if (!relationship) throw "No relationship available";
        let childMap = children.reduce((map, child) => {
            map[child[relationship.child_key]] = map[child[relationship.child_key]] ? [...map[child[relationship.child_key]], child] : [child];
            return map;
        }, {});

        let parentCopy = [...parents];
        parentCopy.forEach(parent => {
            let target = parent_path_to_child.reduce((target, key, i, path) => {
                return target[key];
            }, parent);
            if (Array.isArray(target)) {
                target.forEach(t => t[children_type] = childMap[t[relationship.parent_key]]);
            } else if (target) {
                target[children_type] = childMap[target[relationship.parent_key]];
            }
            return target;
        });
        return parentCopy;
    }

    async query(q, subQueryData, queries) {
        let start = new Date().getTime();
        let queryList = queries || this._buildQuery(q);
        let querySegments = queryList.shift();
        let primary = querySegments[0];

        if (!this.datatypes.includes(primary.type)) return {
            message: `Invalid query - unknown data type: <span class="query-syntax-error">${primary.type}</span>`,
            results: null
        }
        if (primary.filters.some(f => !f.fn)) return {
            message: `Invalid query - could not read filter: <span class="query-syntax-error">${primary.filters.find(f => !f.fn).input}</span>`,
            results: null
        }

        let data;
        if (!subQueryData) {
            data = await this.read(primary.type);
        } else data = subQueryData;
        // Merge in join data
        for (let i = 0; i < querySegments.length; i++) {
            let segment = querySegments[i]
            if (segment.type !== primary.type && this.datatypes.includes(segment.type)) {
                let joinData = await this.read(segment.type);
                let querySegmentTypes = querySegments.map(qs => qs.type);
                try {
                    data = this._join({
                        parents_type: querySegments[i - 1].type,
                        parents: data,
                        parent_path_to_child: querySegmentTypes.slice(querySegmentTypes.indexOf(primary.type) + 1, querySegmentTypes.indexOf(segment.type)),
                        children_type: segment.type,
                        children: joinData
                    });
                } catch (err) {
                    return {
                        message: `Invalid query -- cannot connect <span class="query-syntax-error">${segment.type}</span> to parent`,
                        results: null
                    }
                }
            }
        }

        data = data.filter(d => {
            return this._runQuery(d, querySegments, 0);
        });

        let queryDuration = new Date().getTime() - start;
        if (queryList.length > 0) return this.query(q, data, queryList);
        else return {
            message: `${data.length} results retrieved in ${(queryDuration / 1000).toFixed(2)}s`,
            duration: queryDuration,
            type: primary.type,
            query: q,
            data: data,
            store: this.store
        }
    }

    _buildQuery(q) {
        let queryList = q.split(/\n/g);
        let quantifierRegex = `\\s*([${this._quantifierRegex}])\\s*`;
        return queryList.map(query => query.split(new RegExp(quantifierRegex, 'g')).reduce((queries, el, index, split) => {
            if (index % 2 === 1) {
                queries.push(el + split[index - 1]);
            } else if (index === split.length - 1) {
                queries.push(el);
            }
            return queries;
        }, []).map(segment => {
            let filters = segment.split(/\s*\[\s*(.*?)\s*\]\s*/g).filter(v => v !== "");
            let qFn = this._availableQueryQuantifiers(segment);
            return {
                type: filters.shift().replace(new RegExp(`[${this._quantifierRegex}]`, 'g'), ''),
                quantifier: qFn,
                filters: filters.map(filter => {
                    let filterRegex = `\\s*(${this._filterOperatorRegex})\\s*`;
                    let filterComponents = filter.split(new RegExp(filterRegex, "g"));
                    let field = filterComponents[0], operator = filterComponents[1], argument = filterComponents[2];
                    let fn = this._parseFilter(field, operator, argument);
                    return {
                        input: filter,
                        field: field,
                        operator: operator,
                        argument: argument,
                        fn: fn
                    }
                })
            }
        }));
    }

    _runQuery(data, querySegments, queryDepth) {
        let segment = querySegments[queryDepth];
        let filtersOutcome = typeof data !== "undefined" && segment.filters.every(f => {
            if (Array.isArray(data)) { // Value is array
                return data.some(f.fn);
            } else return f.fn(data);
        });
        let nextQueryOutcome = typeof data !== "undefined";
        if (querySegments[queryDepth + 1]) {
            if (Array.isArray(data[querySegments[queryDepth + 1].type])) {
                nextQueryOutcome = segment.quantifier.apply(data[querySegments[queryDepth + 1].type], [(d) => {
                    return this._runQuery(d, querySegments, queryDepth + 1); // Evaluate next filter
                }]);
            } else if (data[querySegments[queryDepth + 1].type]) {
                nextQueryOutcome = this._runQuery(data[querySegments[queryDepth + 1].type], querySegments, queryDepth + 1);
            } else nextQueryOutcome = segment.quantifier === Array.prototype.none; // [].none is a special case here, where an undefined field is a positive query result
        }
        return filtersOutcome && nextQueryOutcome;
    }

    get _quantifierRegex() {
        return Object.keys(this._availableQueryQuantifiers()).join('');
    }

    _availableQueryQuantifiers(querySegment) {
        let availableQuantifiers = {
            ":": Array.prototype.some,
            "&": Array.prototype.existentialEvery,
            "*": Array.prototype.none
        };
        let operator = querySegment && [...querySegment].find(c => c.match(new RegExp(`[${this._quantifierRegex}]`)));
        if (operator) {
            return availableQuantifiers[operator];
        } else if (querySegment) {
            return availableQuantifiers[":"];
        } else return availableQuantifiers;
    }

    get _filterOperatorRegex() {
        let operators = Object.keys(this._availableQueryFilters()).filter(o => o !== "undefined");
        return `${operators.filter(o => o.toString().length > 1).join("|")}${operators.filter(o => o.toString().length > 1).length > 0 ? "|" : ""}[${operators.filter(o => o.toString().length === 1).join('')}]`;
    }

    _availableQueryFilters(field, operator, argument) {
        let coerce = (a, b, allowDates) => {
            if (typeof a === "undefined" || typeof b === "undefined") return;
            else if (isNaN(+a) == false && isNaN(+b) == false) {
                return [+a, +b];
            } else if (allowDates && isNaN(new Date(a).getTime()) == false && isNaN(new Date(b).getTime()) == false) {
                return [new Date(a), new Date(b)];
            } else return [a ? a.toLowerCase() : a, b === "null" ? null : b.toLowerCase()];
        };
        let availableFilters = {
            undefined: (result) => !!result[field],
            "!": (result) => {
                let c = coerce(result[field], argument);
                return result[field] && c[0] !== c[1];
            },
            "~": (result) => {
                // Strings only
                return result[field] && result[field].toString().toLowerCase().includes(argument.toString().toLowerCase());
            },
            "=": (result) => {
                let c = coerce(result[field], argument);
                return (result[field] === null && argument === "null") || (result[field] && c[0] === c[1]);
            },
            ">": (result) => {
                let c = coerce(result[field], argument, true);
                return result[field] && c[0] > c[1];
            },
            "<": (result) => {
                let c = coerce(result[field], argument, true);
                return result[field] && c[0] < c[1];
            },
            ">=": (result) => {
                let c = coerce(result[field], argument, true);
                return result[field] && c[0] >= c[1];
            },
            "<=": (result) => {
                let c = coerce(result[field], argument, true);
                return result[field] && c[0] <= c[1];
            },
        };
        if (field) return availableFilters[operator];
        else return availableFilters;
    }

    _parseFilter(field, operator, argument) {
        return this._availableQueryFilters(field, operator, argument);
    }

    /**
     *  File access
     */

    // Experimental methods for transforming data points into individual files
    /**
     *  It's very trivial to write an individual file for every data object,
     *  but this creates an enormous amount of files - making reading less efficient &
     *  wasting space by storing the same object keys over and over.
     *
     *  Instead, we can batch the objects together and gzip them. This reduces total storage footprint by
     *  80-90%, reduces the total number of files by 100x-200x, and only introduces a minor speed penalty
     *  when writing.
     *
     *  This requires expanding our indexes to identify which chunk a specific object belongs to. When the write method
     *  is called, we simply write whatever data we have at the moment to a new file and update indices to point to that file.
     *  This way, we do not have to worry about updating previously-written files.
     *
     *  To support write efficiency + increase space efficiency, we also execute a GC phase after max_steps is reached for a store.
     *  In this GC process we:
     *      1) Copy the index file to memory & identify a number of objects we'd like to group together
     *      2) Open the corresponding files
     *      3) Purge any objects not referenced by the index
     *      4) Combine, compress, and write the new file
     *      5) Delete the original files
     *      6) Update the index file
     *
     *  GC can later be tuned for optimized read times.
     */

    _validateDirectories() {
        if (!this._fs.existsSync(path.join(app.getPath('userData'), `./data`))) this._fs.mkdirSync(path.join(app.getPath('userData'), `./data`));
        if (!this._fs.existsSync(path.join(app.getPath('userData'), `./data/files`))) this._fs.mkdirSync(path.join(app.getPath('userData'), `./data/files`));
        if (!this._fs.existsSync(path.join(app.getPath('userData'), `./data/files/${this.store.name}-${this.store.uuid}`))) this._fs.mkdirSync(path.join(app.getPath('userData'), `./data/files/${this.store.name}-${this.store.uuid}`));
        if (!this._fs.existsSync(path.join(app.getPath('userData'), `./data/indices`))) this._fs.mkdirSync(path.join(app.getPath('userData'), `./data/indices`));
    }

    /**
     *  If an index file is corrupted, we replace it with a fresh file.
     *  We try reading the file multiple times, in case the issue is sporadic
     */
    async _validateIndexHealth() {
        let indicesWerePurged = false;
        for (let type of this.datatypes) {
            let indexAccessFailureCount = 0;
            for (let indexAccessAttempts = 0; indexAccessAttempts < 4; indexAccessAttempts++) {
                try {
                    let url = this._getIndexUrl(type);
                    await this._fs.promises.access(url, this._fs.constants.F_OK);
                    let fileBuffer = await this._fs.promises.readFile(url);
                    let dataString = await this._decompress(fileBuffer);
                    JSON.parse(dataString);
                    break;
                } catch (err) {
                    this._log(`Index access failure. Stack trace: \n ${err.stack}`);
                    indexAccessFailureCount++;
                    if (indexAccessFailureCount === 3) {
                        this._log(`Catastrophic index access failure! Index will be deleted. Stack trace:\n ${err.stack}`);
                        await this._writeIndex(type, {});
                        indicesWerePurged = true;
                    }
                }
            }
        }
        return indicesWerePurged;
    }

    /**
     *  The user may exit the application after data has been written, but before it has been indexed.
     *  If an un-indexed file is found, it is deleted here.
     *  If indices with no files are found, remove those indices
     */
    async _validateIndexContents() {
        let indices = await this.readAllIndices();
        let expectedFiles = Object.keys(indices).flatMap(type => Array.from(new Set(Object.values(indices[type]))).map(index => `${type}-${index}`));
        let allDataFiles = this._fs.readdirSync(this._dataPath);
        // Remove unindexed data files
        let unindexedDataFiles = allDataFiles.filter(filename => !expectedFiles.includes(filename));
        unindexedDataFiles.forEach(filename => this._fs.unlinkSync(`${this._dataPath}/${filename}`));
        // Delete stale indices
        let missingFiles = expectedFiles.filter(file => !allDataFiles.includes(file));
        return Promise.all(Object.keys(indices).map(type => {
            Object.keys(indices[type]).forEach(dataId => {
                if (missingFiles.includes(`${type}-${indices[type][dataId]}`)) {
                    delete indices[type][dataId];
                }
            });
            return this._writeIndex(type, indices[type]);
        }));
    }

    /**
     *  Public interface for writing data.
     *  Gzip the incoming data and write it to a new file.
     *  Update the index file.
     *
     *  Should only be used with fresh data from the store (it appends a "Read time" field)
     */
    // Create an index for the provided data, compress+write the chunk file, and read+update+write the index.
    async recordFreshDataChunk(type, data) {
        if (Array.isArray(data) && data.length === 0) return;
        let index = this._uuid.v4();
        data.forEach(d => d["_metadata_write_time"] = new Date().getTime());
        await this._writeData(type, data, index);
        await this._maintainIndex(type, data, index);
    }

    /**
     *  Internal read and write tools
     */

    async _writeData(type, data, index) {
        let compressedData = await this._compress(JSON.stringify(data));
        this._fs.writeFileSync(this._getDataFileUrl(type, index), compressedData);
    }

    async _writeIndex(type, indexData) {
        let compressedIndex = await this._compress(JSON.stringify(indexData));
        this._fs.writeFileSync(this._getIndexUrl(type), compressedIndex);
    }

    async read(type) {
        if (this._queryMode && this.appconfig.queries.use_caching && this._cache.has(type)) {
            return this._cache.get(type);
        }
        let indexUrl = this._getIndexUrl(type);
        let indexFile = await this._read(indexUrl);
        let dataUrls = Array.from(new Set(Object.values(indexFile))).map(index => this._getDataFileUrl(type, index));
        let data = await Promise.all(dataUrls.map(url => this._read(url)));
        if (this._queryMode) {
            data = data.flatMap(r => r);
            data = this.deduplicate(data);
            this._cache.put(type, data);
        }
        return data;
    }

    async _read(url) {
        try {
            await this._fs.promises.access(url, this._fs.constants.F_OK);
            let fileBuffer = await this._fs.promises.readFile(url);
            let dataString = await this._decompress(fileBuffer);
            return JSON.parse(dataString);
        } catch (err) {
            return {};
        }
    }

    calculateDiskUsage() {
        let files = this._fs.readdirSync(this._dataPath);
        return files.reduce((total, file) => total += this._fs.statSync(`${this._dataPath}/${file}`).size, 0);
    }

    async countDataObjects(type) {
        let index = this.readIndex(type);
        return index.length;
    }

    async countIndicesByType() {
        let indices = await this.readAllIndices();
        let result = this.datatypes.reduce((counts, type) => {
            counts[type] = Object.values(indices[type]).length;
            return counts;
        }, {});
        return result;
    }

    async countAllDataObjects() {
        let indices = await this.readAllIndices();
        let result = this.datatypes.reduce((count, type) => {
            return count += indices[type] ? Object.values(indices[type]).length : 0;
        }, 0);
        return result;
    }

    async countDataFiles(type) {
        return this._fs.readdirSync(this._dataPath).filter(f => f.includes(type)).length;
    }

    async countDataFilesByType() {
        let results = {};
        let allFiles = this._fs.readdirSync(this._dataPath);
        this.datatypes.forEach(type => results[type] = allFiles.filter(f => f.includes(type)).length);
        return results;
    }

    async countAllDataFiles() {
        return this._fs.readdirSync(this._dataPath).length;
    }

    async readIndex(type) {
        let indexUrl = this._getIndexUrl(type);
        return this._read(indexUrl);
    }

    async readAllIndices() {
        let allIndices = {};
        for (let type of this.datatypes) allIndices[type] = await this.readIndex(type);
        return allIndices;
    }

    async readAll() {
        let allData = {};
        for (let type of this.datatypes) allData[type] = await this.read(type);
        return allData;
    }

    async _compress(string) {
        return new Promise(r => {
            this._zlib.gzip(Buffer.from(string), null, (err, data) => {
                r(data);
            });
        });
    }

    async _decompress(buffer) {
        return new Promise((resolve, reject) => {
            this._zlib.gunzip(buffer, null, (err, data) => {
                if (err) reject();
                else resolve(data.toString('utf8'));
            });
        });
    }

    async _maintainIndex(type, data, dataIndex) {
        let indexFileUrl = this._getIndexUrl(type);
        let indexFile = await this._read(indexFileUrl);
        data.forEach(d => indexFile[d.id] = dataIndex);
        await this._writeIndex(type, indexFile);
    }

    async _mergeIndexChanges(type, indexChanges) {
        let indexFileUrl = this._getIndexUrl(type);
        let indexFile = await this._read(indexFileUrl);
        Object.keys(indexChanges).forEach(dataId => indexFile[dataId] = indexChanges[dataId]);
        await this._writeIndex(type, indexFile);
    }

    get _dataPath() {
        return path.join(app.getPath('userData'), `./data/files/${this.store.name}-${this.store.uuid}`);
    }

    _getIndexUrl(type) {
        return path.join(app.getPath('userData'), `./data/indices/${this.store.name}-${type}-${this.store.uuid}`);
    }

    _getDataFileUrl(type, id) {
        return path.join(app.getPath('userData'), `./data/files/${this.store.name}-${this.store.uuid}/${type}-${id}`);
    }

    get datatypes() {
        return ['orders', 'fulfillments', 'customers', 'products', 'discounts', 'inventory'];
    }

    /**
     * Expects 1) An array, 2) ids on every member, 3) _metadata_write_time on every member
     * Returns a correctly de-duplicated copy of 'data'
     */
    deduplicate(data) {
        let idWriteTimes = {};
        let descendingSort = (a, b) => {
            if (a > b) return -1;
            else if (a < b) return 1;
            else return 0;
        };
        data.forEach(d => idWriteTimes[d.id] = idWriteTimes[d.id] ? idWriteTimes[d.id].concat(d._metadata_write_time).sort(descendingSort) : [d._metadata_write_time]);
        return data.filter(d => d._metadata_write_time === idWriteTimes[d.id][0] && idWriteTimes[d.id].unshift(0));
    }

    /**
     * For every index file:
     *  1) Read the index
     *  2) Mass data objects into piles, determined by app-config.database.gc_datapile_size
     *  3) Write piles to disk
     *  4) Update and record new index file
     *
     *  This may produce piles that are larger than intended, since dataId:file is many-to-one
     */
    gcTasks() {
        let gcPromises = this.datatypes.map(async type => {
            let indexFileUrl = this._getIndexUrl(type);
            let indexFile = await this._read(indexFileUrl);
            if (!indexFile) return Promise.resolve();

            // Chunks should be "pure" -- they should not reference the same index
            let dataIdChunks = Object.keys(indexFile).pureChunk(this.appconfig.general.gc_datapile_size, indexFile);

            // Saves N-1 Object.keys() operations
            let indexKeys = Object.keys(indexFile);

            let indexMaps = await Promise.all(dataIdChunks.map(async chunk => {
                // File indices referenced by this chunk
                let relatedIndices = Array.from(new Set(chunk.map(dataId => indexFile[dataId])));

                // File locations that contain these data objects
                let dataFileUrls = relatedIndices.map(index => this._getDataFileUrl(type, index));

                // Read the data files related to this chunk
                let dataFileArray = await Promise.all(dataFileUrls.map(url => this._read(url)));

                // Once read, combine them into a single array
                let allData = dataFileArray.flatMap(f => f);

                // These data files may contain unindexed data, we purge those entries here
                allData = allData.filter(d => d.id && indexKeys.includes(d.id.toString()));

                // They may also contain stale data, we purge those here
                allData = allData.filter(d => d.id && chunk.includes(d.id.toString()));

                // Check for duplicates
                allData = this.deduplicate(allData);

                // Write this data, but do not record index changes
                let newIndex = this._uuid.v4();
                await this._writeData(type, allData, newIndex);

                // Once the write is finished, return the new file's index map
                return allData.reduce((changes, dataObject) => {
                    changes[dataObject.id] = newIndex;
                    return changes;
                }, {});
            }));
            await this._mergeIndexChanges(type, indexMaps.reduce((cumulativeMap, map) => Object.assign(cumulativeMap, map), {}));

            // The old data files are now redundant, they can be safely deleted
            let redundantFiles = Array.from(new Set(Object.values(indexFile)));
            await Promise.all(redundantFiles.map(index => this._fs.promises.unlink(this._getDataFileUrl(type, index))));
        });
        return gcPromises;
    }
}

exports.Database = Database;