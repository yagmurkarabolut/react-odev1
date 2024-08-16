var fs = require('fs'),
    path = require('path'),
    Logger = require('bunyan'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter;

function Injection(name, data) {
    this.completed = false;
    this.exports = null;
    this.func = null;
    this.type = 'data';
    if (typeof data === 'function') {
        this.args = data.toString()
            .replace(/((\/\/.*$)|(\/\*[\s\S]*?\*\/)|(\s))/mg,'')
            .match(/^function\s*[^\(]*\(\s*([^\)]*)\)/m)[1]
            .split(/,/)
            .filter(function(e) {
                return !!e;
            });
        this.func = data;
        this.type = data.name;
    } else {
        this.exports = data;
        this.completed = true;
    }
    var self = this;

    this.done = function (error, result) {
        if (error) {
            throw error;
        }
        self.exports = result;
        self.completed = true;
        self.emit('completed', result);
    };

    this.name = name;
    this.injections = [];
    this.async = this.type === 'async';

    EventEmitter.apply(this);

    return this;
}

util.inherits(Injection, EventEmitter);

Injection.prototype.get = function () {
    var self = this;
    return function (callback) {
        if (self.completed) {
            callback(self.exports);
        } else {
            self.on('completed', callback);
        }
    }
};

function Loader(name, config) {
    if (!(this instanceof Loader)) {
        return new Loader(name, config);
    }

    this.name = name;
    this.config = config || {};
    this.config.log = this.config.log || {};
    this.config.log.name = this.config.log.name || name;
    this.config.log.level = this.config.log.level || 'info';

    if (this.config.log instanceof Logger) {
        this.logger = this.config.log.child({
            loader: this.name
        });
    } else {
        this.logger = Logger.createLogger(this.config.log);
    }
}

Loader.prototype.injections = {};
Loader.prototype.wrappers = {};
Loader.prototype.load = function load(dir) {
    var required = [];

    function scan(dir) {
        var files = fs.readdirSync(dir);
        //noinspection JSUnresolvedFunction
        files.forEach(function (file) {
            var fullPath = path.resolve(dir, file),
                stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                return scan(fullPath);
            }
            if (/\.i(?:nject)?\.js$/.test(fullPath)) {
                required.push(require(fullPath));
            }
        });
    }
    
    scan(dir);

    this.prepareFunctions(required);
};

Loader.prototype.prepareFunctions = function prepareFunctions(exports) {
    var execQueue = [],
        name, i = 0;
    for (; i < exports.length; i += 1) {
        var data = exports[i];
        for (name in data) {
            if (!data.hasOwnProperty(name)) {
                continue;
            }

            var injection = new Injection(name, data[name]);
            if (injection.type === 'inject' || injection.type === 'async') {
                this.injections[name] = injection;
            }
            if (injection.type === 'exec') {
                execQueue.push(injection);
            }
        }
    }
    for (i = 0; i < execQueue.length; i += 1) {
        this.invoke(execQueue[i]);
    }
};

function waitArgs(funcs, callback) {
    var lost = funcs.length;
    var args = [];
    if (!funcs.length) {
        return callback(args);
    }
    funcs.forEach(function (func, index) {
        func(function (result) {
            args[index] = result;
            if (--lost === 0) {
                callback(args);
            }
        });
    });
}

Loader.prototype.invoke = function (injection, parentInjections) {
    parentInjections = parentInjections || [];
    if (typeof injection === 'function') {
        this.invoke(new Injection(injection.name || 'anonymous', injection));
        return;
    }

    if (!(injection instanceof Injection)) {
        throw new Error('Don\'t know what to do with this data');
    }

    if (injection.completed) {
        return injection.exports;
    }

    var self = this,
        args = injection.args.map(function (arg) {
            if (injection.async && arg === 'done') {
                return function (callback) {
                    callback(injection.done);
                } 
            }
            var injectionWrapper = self.wrappers[arg];
            if (injectionWrapper) {
                return function (callback) {
                    callback(injectionWrapper.call(self, injection));
                }
            }
            var argInjection = self.injections[arg];
            if (!!~parentInjections.indexOf(injection.name)) {
                //throw new Error('Circular dependency detected');
                self.logger.error('Circular dependency detected %s => %s', injection.name, argInjection.name);
                return argInjection.get();
            }
            if (!argInjection) {
                throw new Error('Function "' + arg + '"  not found');
            }
            self.invoke(argInjection, [].concat(parentInjections, argInjection.args));
            return argInjection.get();
        }),
        result = null;
    
    waitArgs(args, function (args) {
        result = injection.func.apply(null, args);
        if (!injection.async && !injection.completed) {
            injection.done(null, result);
        }
    });

    return result;
};

Loader.prototype.registerWrapper = function (wrapper) {
    if (!wrapper.name) {
        throw new Error('Wrapper must be a function with name');
    }

    if (this.wrappers[wrapper.name]) {
        this.logger.error('Wrapper "%s" already registered', wrapper.name);
    } else {
        this.wrappers[wrapper.name] = wrapper;
    }
};

Loader.prototype.get = function (fromInjection, name) {
    if (!(fromInjection instanceof Injection)) {
        name = fromInjection;
        fromInjection = undefined;
    }
    var wrapper = this.wrappers[name];
    var injection = this.injections[name];
    
    if (wrapper) {
        return wrapper.call(this, fromInjection || {name: 'main'});
    }
    if (injection) {
        return this.invoke(injection, fromInjection && [].concat.apply([], fromInjection.args));
    }

    throw new Error('Cannot find wrapper or injection with this name "' + name + '"');
};

var loader = new Loader('main');

loader.registerWrapper(function logger(injection) {
    return this.logger.child({function: injection.name});
});

loader.registerWrapper(function injector(injection) {
    return this.get.bind(this, injection);
});

Loader.prototype.scope = {};
loader.registerWrapper(function scope() {
    this.scope[this.name] = this.scope[this.name] || {};
    return this.scope[this.name];
});

exports.Loader = Loader;
