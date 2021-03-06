angular.module('angular-meteor.reactive', ['angular-meteor.reactive-scope']).factory('$reactive', ['$rootScope', '$parse', ($rootScope, $parse) => {
  class ReactiveContext {
    constructor(context) {
      if (!context || !angular.isObject(context)) {
        throw new Error('[angular-meteor][ReactiveContext] The context for ReactiveContext is required and must be an object!');
      }

      this.context = context;

      if (this._isScope(this.context)) {
        this.scope = this.context;
      }

      this.stoppables = [];
      this.propertiesTrackerDeps = {};
      this.usingNewScope = false;
    }

    attach(scope) {
      if (!this.scope && this._isScope(scope)) {
        this.scope = scope;
      }

      return this;
    }

    _isScope(obj) {
      return obj instanceof Object.getPrototypeOf($rootScope).constructor;
    }

    _handleCursor(cursor, name) {
      if (angular.isUndefined(this.context[name])) {
        this._setValHelper(name, cursor.fetch());
      }
      else {
        let diff = jsondiffpatch.diff(this.context[name], cursor.fetch());
        jsondiffpatch.patch(this.context[name], diff);
      }

      let initial = true;
      let handle = cursor.observe({
        addedAt: (doc, atIndex) => {
          if (!initial) {
            this.context[name].splice(atIndex, 0, doc);
            this._propertyChanged(name);
          }
        },
        changedAt: (doc, oldDoc, atIndex) => {
          let diff = jsondiffpatch.diff(this.context[name][atIndex], doc);
          jsondiffpatch.patch(this.context[name][atIndex], diff);
          this._propertyChanged(name);
        },
        movedTo: (doc, fromIndex, toIndex) => {
          this.context[name].splice(fromIndex, 1);
          this.context[name].splice(toIndex, 0, doc);
          this._propertyChanged(name);
        },
        removedAt: (oldDoc, atIndex) => {
          this.context[name].splice(atIndex, 1);
          this._propertyChanged(name);
        }
      });
      initial = false;

      return handle;
    };

    _handleNonCursor(data, name) {
      if (angular.isUndefined(this.propertiesTrackerDeps[name]) && angular.isDefined(this.context[name])) {
        console.warn(`[angular-meteor][ReactiveContext] Your tried to create helper named '${name}' on your context, but there's already property with that name - angular-meteor will override it!`);

        this.context[name] = undefined;
      }

      if (angular.isUndefined(this.context[name])) {
        this._setValHelper(name, data);
      }
      else {
        if ((!_.isObject(data) && !_.isArray(data)) ||
          (!_.isObject(this.context[name]) && !_.isArray(this.context[name]))) {
          this.context[name] = data;
        }
        else {
          let diff = jsondiffpatch.diff(this.context[name], data);
          jsondiffpatch.patch(this.context[name], diff);
          this._propertyChanged(name);
        }
      }
    }

    _verifyScope() {
      if (!this.scope) {
        this.usingNewScope = true;
        this.scope = $rootScope.$new(true);
      }
    }

    helpers(props) {
      _.each(props, (v, k) => {
        if (_.isFunction(v)) {
          this._setFnHelper(k, v);
        }
        else {
          console.warn(`[angular-meteor][helpers] Your tried to create helper for primitive '${k}', please note that this feature will be deprecated in 1.4 in favor of using 'getReactively' - http://www.angular-meteor.com/api/1.3.1/get-reactively`);
          this._setValHelper(k, v);

          if (angular.isObject(v)) {
            this.getReactively(k, true);
          }
        }
      });

      return this;
    }

    getReactively(k, objectEquality) {
      let context = this.context;

      if (angular.isUndefined(objectEquality)) {
        objectEquality = false;
      }

      this._verifyScope();

      if (!this.propertiesTrackerDeps[k]) {
        this.propertiesTrackerDeps[k] = new Tracker.Dependency();

        this.scope.$watch(() => {
          return $parse(k)(context);
        }, (newValue, oldValue) => {
          if (newValue !== oldValue) {
            this.propertiesTrackerDeps[k].changed();
          }
        }, objectEquality);
      }

      this.propertiesTrackerDeps[k].depend();

      return $parse(k)(context);
    }

    _setValHelper(k, v) {
      this.getReactively(k, true);

      this.propertiesTrackerDeps[k] = new Tracker.Dependency();

      v = _.clone(v);

      Object.defineProperty(this.context, k, {
        configurable: true,
        enumerable: true,

        get: () => {
          this.propertiesTrackerDeps[k].depend();
          return v;
        },
        set: (newValue) => {
          v = newValue;
          this._propertyChanged(k);
        }
      });
    }

    _setFnHelper(k, fn) {
      this.stoppables.push(Tracker.autorun((comp) => {
        let data = fn.apply(this.context);

        Tracker.nonreactive(() => {
          if (this._isMeteorCursor(data)) {
            let stoppableObservation = this._handleCursor(data, k);

            comp.onInvalidate(() => {
              stoppableObservation.stop();
              // empty set once cursor is invalidated
              this.context[k].splice(0);
            });
          }
          else {
            this._handleNonCursor(data, k);
          }

          this._propertyChanged(k);
        });
      }));
    }

    _isMeteorCursor(obj) {
      return obj instanceof Mongo.Collection.Cursor;
    }

    _propertyChanged(k) {
      if (this.scope && !$rootScope.$$phase) {
        this.scope.$digest();
      }

      this.propertiesTrackerDeps[k].changed();
    }

    subscribe(name, fn, resultCb) {
      if (!angular.isString(name)) {
        throw new Error(`[angular-meteor][ReactiveContext] The first argument of 'subscribe' method must be a string!`);
      }

      fn = fn || angular.noop;
      resultCb = resultCb || angular.noop;

      if (!angular.isFunction(fn)) {
        throw new Error(`[angular-meteor][ReactiveContext] The second argument of 'subscribe' method must be a function!`);
      }

      if (this.scope && this.scope !== this.context) {
        this.stoppables.push(this.scope.subscribe(name, fn, resultCb));
      }
      else {
        this.autorun(() => {
          let args = fn() || [];

          if (!angular.isArray(args)) {
            throw new Error(`[angular-meteor][ReactiveContext] The return value of arguments function in subscribe must be an array! `);
          }

          this.stoppables.push(Meteor.subscribe(name, ...args, resultCb));
        });
      }

      return this;
    }

    autorun(fn) {
      if (this.scope && this.scope !== this.context) {
        this.scope.autorun(fn);
      }
      else {
        this.stoppables.push(Meteor.autorun(fn));
      }

      return this;
    }

    stop() {
      angular.forEach(this.stoppables, (stoppable) => {
        stoppable.stop();
      });

      this.stoppables = [];

      if (this.usingNewScope) {
        this.scope.$destroy();
        this.scope = undefined;
      }

      return this;
    }
  }

  return function (context) {
    let reactiveContext = new ReactiveContext(context);

    // manipulates the original context so it could access reactive methods
    _.keys(ReactiveContext.prototype)
      .filter((k) => k.charAt(0) != '_')
      .forEach((k) => context[k] = reactiveContext[k].bind(reactiveContext));

    return reactiveContext;
  };
}]);
