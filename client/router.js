import { FlowRouter, Route, Group, Triggers, BlazeRenderer } from './_init.js';
import { EJSON }    from 'meteor/ejson';
import { Meteor }   from 'meteor/meteor';
import { Tracker }  from 'meteor/tracker';
import { _helpers } from './../lib/_helpers.js';
import { page, qs } from './modules.js';

// let isNavigating = false;

class Router {
  constructor() {
    this.pathRegExp = /(:[\w\(\)\\\+\*\.\?\[\]\-]+)+/g;
    this.globals = [];
    this.subscriptions = Function.prototype;
    this.Renderer = new BlazeRenderer({ router: this });

    this._tracker = this._buildTracker();
    this._current = {};
    this._specialChars = ['/', '%', '+'];
    this._encodeParam = (param) => {
      const paramArr = param.split('');
      let _param = '';
      for (let i = 0; i < paramArr.length; i++) {
        if (this._specialChars.includes(paramArr[i])){
          _param += encodeURIComponent(encodeURIComponent(paramArr[i]));
        } else {
          try {
            _param += encodeURIComponent(paramArr[i]);
          } catch (e) {
            _param += paramArr[i];
          }
        }
      }
      return _param;
    };

    // tracks the current path change
    this._onEveryPath = new Tracker.Dependency();

    this._globalRoute = new Route(this);

    // holds onRoute callbacks
    this._onRouteCallbacks = [];

    // if _askedToWait is true. We don't automatically start the router
    // in Meteor.startup callback. (see client/_init.js)
    // Instead user need to call `.initialize()
    this._askedToWait = false;
    this._initialized = false;
    this._triggersEnter = [];
    this._triggersExit = [];
    this._routes = [];
    this._routesMap = {};
    this._updateCallbacks();
    this._notFound = null;
    this.notfound = this.notFound;
    // indicate it's okay (or not okay) to run the tracker
    // when doing subscriptions
    // using a number and increment it help us to support FlowRouter.go()
    // and legitimate reruns inside tracker on the same event loop.
    // this is a solution for #145
    this.safeToRun = 0;

    // Meteor exposes to the client the path prefix that was defined using the
    // ROOT_URL environement variable on the server using the global runtime
    // configuration. See #315.
    this._basePath = window.__meteor_runtime_config__.ROOT_URL_PATH_PREFIX || '';

    // this is a chain contains a list of old routes
    // most of the time, there is only one old route
    // but when it's the time for a trigger redirect we've a chain
    this._oldRouteChain = [];

    this.env = {
      replaceState: new Meteor.EnvironmentVariable(),
      reload: new Meteor.EnvironmentVariable(),
      trailingSlash: new Meteor.EnvironmentVariable()
    };

    // Implementing Reactive APIs
    const reactiveApis = [
      'getParam', 'getQueryParam',
      'getRouteName', 'watchPathChange'
    ];

    reactiveApis.forEach((api) => {
      this[api] = function (arg1) {
        // when this is calling, there may not be any route initiated
        // so we need to handle it
        const currentRoute = this._current.route;
        if (!currentRoute) {
          this._onEveryPath.depend();
          return void 0;
        }

        // currently, there is only one argument. If we've more let's add more args
        // this is not clean code, but better in performance
        return currentRoute[api].call(currentRoute, arg1);
      };
    });

    // redirect function used inside triggers
    this._redirectFn = (pathDef, fields, queryParams) => {
      if (/^http(s)?:\/\//.test(pathDef)) {
        throw new Error("Redirects to URLs outside of the app are not supported in this version of Flow Router. Use 'window.location = yourUrl' instead");
      }

      this.withReplaceState(() => {
        this._page.redirect(FlowRouter.path(pathDef, fields, queryParams));
      });
    };
    this._initTriggersAPI();
  }

  set notFound(opts) {
    Meteor._debug('FlowRouter.notFound is deprecated, use FlowRouter.route(\'*\', { /*...*/ }) instead!');
    opts.name = opts.name || '__notFound';
    this._notFound = this.route('*', opts);
  }

  get notFound() {
    return this._notFound;
  }

  get _page() {
    return page;
  }

  get _qs() {
    return qs;
  }

  route(pathDef, options = {}, group) {
    if (!/^\//.test(pathDef) && pathDef !== '*') {
      throw new Error("route's path must start with '/'");
    }

    const route = new Route(this, pathDef, options, group);

    // calls when the page route being activates
    route._actionHandle = (context) => {
      // if (isNavigating) {
      //   return;
      // }
      // isNavigating = true;
      const oldRoute = this._current.route;
      this._oldRouteChain.push(oldRoute);

      // _qs.parse() gives us a object without prototypes,
      // created with Object.create(null)
      // Meteor's check doesn't play nice with it.
      // So, we need to fix it by cloning it.
      // see more: https://github.com/meteorhacks/flow-router/issues/164
      
      // In addition to the above, query params also inappropriately
      // get decoded twice. The ternary below fixes this bug if the
      // "decodeQueryParamsOnce" option is set to true, so that we
      // don't break legacy applications. The "example.com" domain
      // below is insignificant but only used to create a URL object
      // from which we can parse out query params reliably from the
      // still-encoded path instead of the prematurely decoded
      // querystring.
      // See: https://github.com/veliovgroup/flow-router/issues/78
      const queryParams = this._qs.parse((this.decodeQueryParamsOnce) ? (new URL(context.path, "http://example.com")).searchParams.toString() : context.querystring);
      this._current = {
        path: context.path,
        params: context.params,
        route,
        context,
        oldRoute,
        queryParams
      };

      // we need to invalidate if all the triggers have been completed
      // if not that means, we've been redirected to another path
      // then we don't need to invalidate
      const afterAllTriggersRan = () => {
        // isNavigating = false;
        this._invalidateTracker();
      };

      route.waitOn(this._current, (current, data) => {
        Triggers.runTriggers(
          this._triggersEnter.concat(route._triggersEnter),
          this._current,
          this._redirectFn,
          afterAllTriggersRan,
          data
        );
      });
    };

    // calls when you exit from the page js route
    route._exitHandle = (context, next) => {
      Triggers.runTriggers(
        this._triggersExit.concat(route._triggersExit),
        this._current,
        this._redirectFn,
        next
      );
    };

    this._routes.push(route);
    if (options.name) {
      this._routesMap[options.name] = route;
    }

    this._updateCallbacks();
    this._triggerRouteRegister(route);

    return route;
  }

  group(options) {
    return new Group(this, options);
  }

  path(_pathDef, fields = {}, queryParams) {
    let pathDef = _pathDef;
    if (this._routesMap[pathDef]) {
      pathDef = this._routesMap[pathDef].pathDef;
    }

    let path = '';

    // Prefix the path with the router global prefix
    if (this._basePath) {
      path += `/${this._basePath}/`;
    }

    path += pathDef.replace(this.pathRegExp, (_key) => {
      const firstRegexpChar = _key.indexOf('(');
      // get the content behind : and (\\d+/)
      let key = _key.substring(1, (firstRegexpChar > 0) ? firstRegexpChar : undefined);
      // remove +?*
      key = key.replace(/[\+\*\?]+/g, '');

      // this is to allow page js to keep the custom characters as it is
      // we need to encode 2 times otherwise "/" char does not work properly
      // So, in that case, when I includes "/" it will think it's a part of the
      // route. encoding 2times fixes it
      if (fields[key]) {
        return this._encodeParam(`${fields[key]}`);
      }

      return '';
    });

    // Replace multiple slashes with single slash
    path = path.replace(/\/\/+/g, '/');

    // remove trailing slash
    // but keep the root slash if it's the only one
    path = path.match(/^\/{1}$/) ? path : path.replace(/\/$/, '');

    // explictly asked to add a trailing slash
    if (this.env.trailingSlash.get() && path[path.length - 1] !== '/') {
      path += '/';
    }

    const strQueryParams = this._qs.stringify(queryParams || {});
    if (strQueryParams) {
      path += `?${strQueryParams}`;
    }

    path = path.replace(/\/\/+/g, '/');
    return path;
  }

  go(pathDef, fields, queryParams) {
    // if (isNavigating) {
    //   return;
    // }
    const path = this.path(pathDef, fields, queryParams);
    if (!this.env.reload.get() && path === this._current.path) {
      return;
    }

    // THIS DESCISION ISN'T CLEAR
    // WE SHOULD AVOID .go() METHOD
    // IF WE ARE CURRETLY NAVIGATING
    // BUT AT THE SAME TIME IT MAY BREAK
    // REDIRECTS AND MORE COMPLEX LOGIC
    // SO WE WILL LEAVE IT COMMENTED AND
    // AS IT IS FOR NOW TO AVOID COMPATIBILITY ISSUES
    // SEARCH FOR `isNavigating` VARIABLE ACROSS THIS
    // FILE TO LEARN MORE.
    // OH... CLIENT-SIDE NAVIGATION AIN'T SIMPLE THING
    // isNavigating = true;

    try {
      if (this.env.replaceState.get()) {
        this._page.replace(path);
      } else {
        this._page(path);
      }
    } catch (e) {
      Meteor._debug('Malformed URI!', path, e);
    }
  }

  reload() {
    this.env.reload.withValue(true, () => {
      this._page.replace(this._current.path);
    });
  }

  redirect(path) {
    this._page.redirect(path);
  }

  setParams(newParams) {
    if (!this._current.route) {return false;}

    const pathDef = this._current.route.pathDef;
    const existingParams = this._current.params;
    let params = {};
    Object.keys(existingParams).forEach((key) => {
      params[key] = existingParams[key];
    });

    params = _helpers.extend(params, newParams);
    const queryParams = this._current.queryParams;

    this.go(pathDef, params, queryParams);
    return true;
  }

  setQueryParams(newParams) {
    if (!this._current.route) {return false;}

    const queryParams = _helpers.extend(_helpers.clone(this._current.queryParams), newParams);

    for (const k in queryParams) {
      if (queryParams[k] === null || queryParams[k] === undefined) {
        delete queryParams[k];
      }
    }

    const pathDef = this._current.route.pathDef;
    const params = this._current.params;
    this.go(pathDef, params, queryParams);
    return true;
  }

  // .current is not reactive
  // This is by design. use .getParam() instead
  // If you really need to watch the path change, use .watchPathChange()
  current() {
    // We can't trust outside, that's why we clone this
    // Anyway, we can't clone the whole object since it has non-jsonable values
    // That's why we clone what's really needed.
    const current = _helpers.clone(this._current);
    current.queryParams = EJSON.clone(current.queryParams);
    current.params = EJSON.clone(current.params);
    return current;
  }

  track(reactiveMapper) {
    return (props, onData, env) => {
      let trackerCleanup = null;
      const handler = Tracker.nonreactive(() => {
        return Tracker.autorun(() => {
          trackerCleanup = reactiveMapper(props, onData, env);
        });
      });

      return () => {
        if (typeof trackerCleanup === 'function') {
          trackerCleanup();
        }
        return handler.stop();
      };
    };
  }

  mapper(props, onData, env) {
    if (typeof onData === 'function') {
      onData(null, { route: this.current(), props, env });
    }
  }

  trackMapper() {
    return this.track(this.mapper);
  }

  subsReady() {
    let callback = null;
    const args = Array.from(arguments);

    if (typeof args[args.length - 1] === 'function') {
      callback = args.pop();
    }

    const currentRoute = this.current().route;
    const globalRoute = this._globalRoute;

    // we need to depend for every route change and
    // rerun subscriptions to check the ready state
    this._onEveryPath.depend();

    if (!currentRoute) {
      return false;
    }

    let subscriptions;
    if (args.length === 0) {
      subscriptions = Object.values(globalRoute.getAllSubscriptions());
      subscriptions = subscriptions.concat(Object.values(currentRoute.getAllSubscriptions()));
    } else {
      subscriptions = args.map((subName) => {
        return globalRoute.getSubscription(subName) || currentRoute.getSubscription(subName);
      });
    }

    const isReady = () => {
      const ready =  subscriptions.every((sub) => {
        return sub && sub.ready();
      });

      return ready;
    };

    if (callback) {
      Tracker.autorun((c) => {
        if (isReady()) {
          callback();
          c.stop();
        }
      });
      return true;
    }
    return isReady();
  }

  withReplaceState(fn) {
    return this.env.replaceState.withValue(true, fn);
  }

  withTrailingSlash(fn) {
    return this.env.trailingSlash.withValue(true, fn);
  }

  initialize(options = {}) {
    if (this._initialized) {
      throw new Error('FlowRouter is already initialized');
    }

    const self = this;
    this._updateCallbacks();

    // Implementing idempotent routing
    // by overriding page.js`s "show" method.
    // Why?
    // It is impossible to bypass exit triggers,
    // because they execute before the handler and
    // can not know what the next path is, inside exit trigger.
    //
    // we need override both show, replace to make this work
    // since we use redirect when we are talking about withReplaceState
    ['show', 'replace'].forEach((fnName) => {
      const original = self._page[fnName];
      self._page[fnName] = function (path, state, dispatch, push) {
        if (!path || (!self.env.reload.get() && self._current.path === path)) {
          return;
        }
        original.call(this, path.replace(/\/\/+/g, '/'), state, dispatch, push);
      };
    });

    // this is very ugly part of pagejs and it does decoding few times
    // in unpredicatable manner. See #168
    // this is the default behaviour and we need keep it like that
    // we are doing a hack. see .path()
    this._page.base(this._basePath);

    this._page(Object.assign({
      hashbang: !!options.hashbang,
      decodeURLComponents: true
    }, options.page || {}));

    this._initialized = true;
  }

  _buildTracker() {
    // main autorun function
    const tracker = Tracker.autorun(() => {
      if (!this._current || !this._current.route) {
        return;
      }

      // see the definition of `this._processingContexts`
      const currentContext = this._current;
      const route = currentContext.route;
      const path = currentContext.path;

      if (this.safeToRun === 0) {
        throw new Error("You can't use reactive data sources like Session inside the `.subscriptions` method!");
      }

      // We need to run subscriptions inside a Tracker
      // to stop subs when switching between routes
      // But we don't need to run this tracker with
      // other reactive changes inside the .subscription method
      // We tackle this with the `safeToRun` variable
      this._globalRoute.clearSubscriptions();
      this.subscriptions.call(this._globalRoute, path);
      route.callSubscriptions(currentContext);

      // otherwise, computations inside action will trigger to re-run
      // this computation. which we do not need.
      Tracker.nonreactive(() => {
        let isRouteChange = currentContext.oldRoute !== currentContext.route;
        // first route is not a route change
        if (!currentContext.oldRoute) {
          isRouteChange = false;
        }

        // Clear oldRouteChain just before calling the action
        // We still need to get a copy of the oldestRoute first
        // It's very important to get the oldest route and registerRouteClose() it
        // See: https://github.com/kadirahq/flow-router/issues/314
        const oldestRoute = this._oldRouteChain[0];
        this._oldRouteChain = [];

        currentContext.route.registerRouteChange(currentContext, isRouteChange);
        route.callAction(currentContext);

        Tracker.afterFlush(() => {
          this._onEveryPath.changed();
          if (isRouteChange) {
            // We need to trigger that route (definition itself) has changed.
            // So, we need to re-run all the register callbacks to current route
            // This is pretty important, otherwise tracker
            // can't identify new route's items

            // We also need to afterFlush, otherwise this will re-run
            // helpers on templates which are marked for destroying
            if (oldestRoute && oldestRoute.registerRouteClose) {
              oldestRoute.registerRouteClose();
            }
          }
        });
      });

      this.safeToRun--;
    });

    return tracker;
  }

  _invalidateTracker() {
    this.safeToRun++;
    this._tracker.invalidate();
    // After the invalidation we need to flush to make changes immediately
    // otherwise, we have face some issues context mix-matches and so on.
    // But there are some cases we can't flush. So we need to ready for that.

    // we clearly know, we can't flush inside an autorun
    // this may leads some issues on flow-routing
    // we may need to do some warning
    if (!Tracker.currentComputation) {
      // Still there are some cases where we can't flush
      //  eg:- when there is a flush currently
      // But we've no public API or hacks to get that state
      // So, this is the only solution
      try {
        Tracker.flush();
      } catch(ex) {
        // only handling "while flushing" errors
        if (!/Tracker\.flush while flushing/.test(ex.message)) {
          return;
        }

        // XXX: fix this with a proper solution by removing subscription mgt.
        // from the router. Then we don't need to run invalidate using a tracker

        // this happens when we are trying to invoke a route change
        // with inside a route change. (eg:- Template.onCreated)
        // Since we use page.js and tracker, we don't have much control
        // over this process.
        // only solution is to defer route execution.

        // It's possible to have more than one path want to defer
        // But, we only need to pick the last one.
        // self._nextPath = self._current.path;
        Meteor.defer(() => {
          const path = this._nextPath;
          if (!path) {
            return;
          }

          delete this._nextPath;
          this.env.reload.withValue(true, () => {
            this.go(path);
          });
        });
      }
    }
  }

  _updateCallbacks() {
    this._page.callbacks = [];
    this._page.exits = [];
    let catchAll = null;

    this._routes.forEach((route) => {
      if (route.pathDef === '*') {
        catchAll = route;
      } else {
        this._page(route.pathDef, route._actionHandle);
        this._page.exit(route.pathDef, route._exitHandle);
      }
    });

    // Setting exit triggers on catch all routes leads to weird behavior.
    // We recommend to avoid enter and exit triggers on catch all (`*`) routes.
    // Use FlowRouter.triggers.exit([func]) and FlowRouter.triggers.enter([func]) instead
    if (catchAll) {
      this._page(catchAll.pathDef, catchAll._actionHandle);
      // this._page.exit(catchAll.pathDef, catchAll._exitHandle);
    }
  }

  _initTriggersAPI() {
    const self = this;
    this.triggers = {
      enter(_triggers, filter) {
        let triggers = Triggers.applyFilters(_triggers, filter);
        if (triggers.length) {
          self._triggersEnter = self._triggersEnter.concat(triggers);
        }
      },
      exit(_triggers, filter) {
        let triggers = Triggers.applyFilters(_triggers, filter);
        if (triggers.length) {
          self._triggersExit = self._triggersExit.concat(triggers);
        }
      }
    };
  }

  wait() {
    if (this._initialized) {
      throw new Error("can't wait after FlowRouter has been initialized");
    }

    this._askedToWait = true;
  }

  onRouteRegister(cb) {
    this._onRouteCallbacks.push(cb);
  }

  _triggerRouteRegister(currentRoute) {
    // We should only need to send a safe set of fields on the route
    // object.
    // This is not to hide what's inside the route object, but to show
    // these are the public APIs
    const routePublicApi = _helpers.pick(currentRoute, ['name', 'pathDef', 'path']);
    routePublicApi.options = _helpers.omit(currentRoute.options, ['triggersEnter', 'triggersExit', 'action', 'subscriptions', 'name']);

    this._onRouteCallbacks.forEach((cb) => {
      cb(routePublicApi);
    });
  }

  url() {
    // We need to remove the leading base path, or "/", as it will be inserted
    // automatically by `Meteor.absoluteUrl` as documented in:
    // http://docs.meteor.com/#/full/meteor_absoluteurl
    return Meteor.absoluteUrl(this.path.apply(this, arguments).replace(new RegExp('^' + (`/${this._basePath || ''}/`).replace(/\/\/+/g, '/')), ''));
  }
}

export default Router;
