var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/util/ast.js
function getEffectDepsRefs(context, node) {
  const depsArr = node.arguments[1];
  if (depsArr?.type !== "ArrayExpression") {
    return void 0;
  }
  return getDownstreamRefs(context, depsArr);
}
var import_eslint_utils, isReactFunctionalComponent, isReactFunctionalHOC, isCustomHook, isUseState, hasCleanup, isPropDef, isUseRef, isUseEffect, getEffectFnRefs, isStateSetter, isPropCallback, isRefCall, isState, isProp, isRef, getUseStateNode, isImmediateCall, getUpstreamRefs, traverse, findDownstreamNodes, getDownstreamRefs, getRef, getCallExpr, isArgsAllLiterals;
var init_ast = __esm({
  "src/util/ast.js"() {
    import_eslint_utils = require("eslint-utils");
    isReactFunctionalComponent = (node) => (node.type === "FunctionDeclaration" || node.type === "VariableDeclarator" && (node.init.type === "ArrowFunctionExpression" || node.init.type === "CallExpression")) && node.id.type === "Identifier" && node.id.name[0].toUpperCase() === node.id.name[0];
    isReactFunctionalHOC = (node) => node.type === "VariableDeclarator" && node.init && node.init.type === "CallExpression" && node.init.callee.type === "Identifier" && !["memo", "forwardRef"].includes(node.init.callee.name) && node.init.arguments.length > 0 && (node.init.arguments[0].type === "ArrowFunctionExpression" || node.init.arguments[0].type === "FunctionExpression") && node.id.type === "Identifier" && node.id.name[0].toUpperCase() === node.id.name[0];
    isCustomHook = (node) => (node.type === "FunctionDeclaration" || node.type === "VariableDeclarator" && node.init && (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression")) && node.id.type === "Identifier" && node.id.name.startsWith("use") && node.id.name[3] === node.id.name[3].toUpperCase();
    isUseState = (node) => node.type === "VariableDeclarator" && node.init && node.init.type === "CallExpression" && node.init.callee.name === "useState" && node.id.type === "ArrayPattern" && // Not sure its usecase, but may just have the setter
    (node.id.elements.length === 1 || node.id.elements.length === 2) && node.id.elements.every((el) => {
      return !el || el.type === "Identifier";
    });
    hasCleanup = (node) => {
      const effectFn = node.arguments[0];
      return (effectFn.type === "ArrowFunctionExpression" || effectFn.type === "FunctionExpression") && effectFn.body.type === "BlockStatement" && effectFn.body.body.some(
        (stmt) => stmt.type === "ReturnStatement" && stmt.argument
      );
    };
    isPropDef = (def) => {
      const declaringNode = def.node.type === "ArrowFunctionExpression" ? def.node.parent.type === "CallExpression" ? def.node.parent.parent : def.node.parent : def.node;
      return def.type === "Parameter" && (isReactFunctionalComponent(declaringNode) && !isReactFunctionalHOC(declaringNode) || isCustomHook(declaringNode));
    };
    isUseRef = (node) => node.type === "VariableDeclarator" && node.init && node.init.type === "CallExpression" && node.init.callee.name === "useRef" && node.id.type === "Identifier";
    isUseEffect = (node) => node.type === "CallExpression" && (node.callee.type === "Identifier" && node.callee.name === "useEffect" || node.callee.type === "MemberExpression" && node.callee.object.name === "React" && node.callee.property.name === "useEffect");
    getEffectFnRefs = (context, node) => {
      const effectFn = node.arguments[0];
      if (effectFn?.type !== "ArrowFunctionExpression" && effectFn?.type !== "FunctionExpression") {
        return void 0;
      }
      return getDownstreamRefs(context, effectFn);
    };
    isStateSetter = (context, ref) => getCallExpr(ref) !== void 0 && getUpstreamRefs(context, ref).some((ref2) => isState(ref2));
    isPropCallback = (context, ref) => getCallExpr(ref) !== void 0 && getUpstreamRefs(context, ref).some((ref2) => isProp(ref2));
    isRefCall = (context, ref) => getCallExpr(ref) !== void 0 && getUpstreamRefs(context, ref).some((ref2) => isRef(ref2));
    isState = (ref) => ref.resolved.defs.some((def) => isUseState(def.node));
    isProp = (ref) => ref.resolved.defs.some((def) => isPropDef(def));
    isRef = (ref) => ref.resolved.defs.some((def) => isUseRef(def.node));
    getUseStateNode = (context, ref) => {
      return getUpstreamRefs(context, ref).map((ref2) => ref2.resolved).find((variable) => variable.defs.some((def) => isUseState(def.node)))?.defs.find((def) => isUseState(def.node))?.node;
    };
    isImmediateCall = (node) => {
      if (!node.parent) {
        return false;
      } else if (isUseEffect(node.parent)) {
        return true;
      } else if (
        // Obviously not immediate if async. I think this never occurs in isolation from the below conditions? But just in case for now.
        node.async || // Inside a named or anonymous function that may be called later, either as a callback or by the developer.
        // Note while we return false for *this* call, we may still return true for a call to the function containing this call.
        node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression"
      ) {
        return false;
      } else {
        return isImmediateCall(node.parent);
      }
    };
    getUpstreamRefs = (context, ref, visited = /* @__PURE__ */ new Set()) => {
      if (visited.has(ref)) {
        return [];
      } else if (!ref.resolved) {
        return [];
      } else if (
        // Ignore function parameters references, aside from props.
        // They are self-contained and essentially duplicate the argument reference.
        // Important to use `notEmptyEvery` because global variables have an empty `defs`.
        ref.resolved.defs.notEmptyEvery(
          (def) => def.type === "Parameter" && !isPropDef(def)
        )
      ) {
        return [];
      }
      visited.add(ref);
      const upstreamRefs = ref.resolved.defs.filter((def) => !!def.node.init).filter((def) => !isUseState(def.node)).flatMap((def) => getDownstreamRefs(context, def.node.init)).flatMap((ref2) => getUpstreamRefs(context, ref2, visited));
      return upstreamRefs.length === 0 ? [ref] : upstreamRefs;
    };
    traverse = (context, node, visit, visited = /* @__PURE__ */ new Set()) => {
      if (visited.has(node)) {
        return;
      }
      visited.add(node);
      visit(node);
      (context.sourceCode.visitorKeys[node.type] || []).map((key) => node[key]).filter(Boolean).flatMap((child) => Array.isArray(child) ? child : [child]).filter(Boolean).filter((child) => typeof child.type === "string").forEach((child) => traverse(context, child, visit, visited));
    };
    findDownstreamNodes = (context, topNode, type) => {
      const nodes = [];
      traverse(context, topNode, (node) => {
        if (node.type === type) {
          nodes.push(node);
        }
      });
      return nodes;
    };
    getDownstreamRefs = (context, node) => findDownstreamNodes(context, node, "Identifier").map((identifier) => getRef(context, identifier)).filter(Boolean);
    getRef = (context, identifier) => (0, import_eslint_utils.findVariable)(
      context.sourceCode.getScope(identifier),
      identifier
    )?.references.find((ref) => ref.identifier === identifier);
    getCallExpr = (ref, current = ref.identifier.parent) => {
      if (current.type === "CallExpression") {
        let node = ref.identifier;
        while (node.parent.type === "MemberExpression") {
          node = node.parent;
        }
        if (current.callee === node) {
          return current;
        }
      }
      if (current.type === "MemberExpression") {
        return getCallExpr(ref, current.parent);
      }
      return void 0;
    };
    isArgsAllLiterals = (context, callExpr) => callExpr.arguments.flatMap((arg) => getDownstreamRefs(context, arg)).flatMap((ref) => getUpstreamRefs(context, ref)).length === 0;
  }
});

// src/rules/no-empty-effect.js
var no_empty_effect_default;
var init_no_empty_effect = __esm({
  "src/rules/no-empty-effect.js"() {
    init_ast();
    no_empty_effect_default = {
      meta: {
        type: "suggestion",
        docs: {
          description: "Disallow empty effects."
        },
        schema: [],
        messages: {
          avoidEmptyEffect: "This effect is empty and could be removed."
        }
      },
      create: (context) => ({
        CallExpression: (node) => {
          if (!isUseEffect(node)) return;
          if (node.arguments?.length === 0 || getEffectFnRefs(context, node)?.length === 0) {
            context.report({
              node,
              messageId: "avoidEmptyEffect"
            });
          }
        }
      })
    };
  }
});

// src/rules/no-adjust-state-on-prop-change.js
var no_adjust_state_on_prop_change_default;
var init_no_adjust_state_on_prop_change = __esm({
  "src/rules/no-adjust-state-on-prop-change.js"() {
    init_ast();
    init_ast();
    no_adjust_state_on_prop_change_default = {
      meta: {
        type: "suggestion",
        docs: {
          description: "Disallow adjusting state in an effect when a prop changes.",
          url: "https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes"
        },
        schema: [],
        messages: {
          avoidAdjustingStateWhenAPropChanges: "Avoid adjusting state when a prop changes. Instead, adjust the state directly during render, or refactor your state to avoid this need entirely."
        }
      },
      create: (context) => ({
        CallExpression: (node) => {
          if (!isUseEffect(node)) return;
          const effectFnRefs = getEffectFnRefs(context, node);
          const depsRefs = getEffectDepsRefs(context, node);
          if (!effectFnRefs || !depsRefs) return;
          const isAllDepsProps = depsRefs.flatMap((ref) => getUpstreamRefs(context, ref)).notEmptyEvery((ref) => isProp(ref));
          effectFnRefs.filter((ref) => isStateSetter(context, ref)).filter((ref) => isImmediateCall(ref.identifier)).forEach((ref) => {
            const callExpr = getCallExpr(ref);
            if (isAllDepsProps && isArgsAllLiterals(context, callExpr)) {
              context.report({
                node: callExpr,
                messageId: "avoidAdjustingStateWhenAPropChanges"
              });
            }
          });
        }
      })
    };
  }
});

// src/rules/no-reset-all-state-on-prop-change.js
var no_reset_all_state_on_prop_change_default, findPropUsedToResetAllState, isSetStateToInitialValue, countUseStates, findContainingNode;
var init_no_reset_all_state_on_prop_change = __esm({
  "src/rules/no-reset-all-state-on-prop-change.js"() {
    init_ast();
    init_ast();
    no_reset_all_state_on_prop_change_default = {
      meta: {
        type: "suggestion",
        docs: {
          description: "Disallow resetting all state in an effect when a prop changes.",
          url: "https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes"
        },
        schema: [],
        messages: {
          avoidResettingAllStateWhenAPropChanges: 'Avoid resetting all state when a prop changes. If "{{prop}}" is a key, pass it as `key` instead so React will reset the component.'
        }
      },
      create: (context) => ({
        CallExpression: (node) => {
          if (!isUseEffect(node)) return;
          const effectFnRefs = getEffectFnRefs(context, node);
          const depsRefs = getEffectDepsRefs(context, node);
          if (!effectFnRefs || !depsRefs) return;
          const containingNode = findContainingNode(node);
          if (containingNode && isCustomHook(containingNode)) return;
          const propUsedToResetAllState = findPropUsedToResetAllState(
            context,
            effectFnRefs,
            depsRefs,
            node
          );
          if (propUsedToResetAllState) {
            context.report({
              node,
              messageId: "avoidResettingAllStateWhenAPropChanges",
              data: { prop: propUsedToResetAllState.identifier.name }
            });
          }
        }
      })
    };
    findPropUsedToResetAllState = (context, effectFnRefs, depsRefs, useEffectNode) => {
      const stateSetterRefs = effectFnRefs.filter(
        (ref) => isStateSetter(context, ref)
      );
      const isAllStateReset = stateSetterRefs.length > 0 && stateSetterRefs.every((ref) => isSetStateToInitialValue(context, ref)) && stateSetterRefs.length === countUseStates(context, findContainingNode(useEffectNode));
      return isAllStateReset ? depsRefs.flatMap((ref) => getUpstreamRefs(context, ref)).find((ref) => isProp(ref)) : void 0;
    };
    isSetStateToInitialValue = (context, setterRef) => {
      const setStateToValue = getCallExpr(setterRef).arguments[0];
      const stateInitialValue = getUseStateNode(context, setterRef).init.arguments[0];
      const isUndefined = (node) => node === void 0 || node.name === "undefined";
      if (isUndefined(setStateToValue) && isUndefined(stateInitialValue)) {
        return true;
      }
      if (setStateToValue === null && stateInitialValue === null) {
        return true;
      } else if (setStateToValue && !stateInitialValue || !setStateToValue && stateInitialValue) {
        return false;
      }
      return context.sourceCode.getText(setStateToValue) === context.sourceCode.getText(stateInitialValue);
    };
    countUseStates = (context, componentNode) => {
      if (!componentNode) {
        return 0;
      }
      let count = 0;
      traverse(context, componentNode, (node) => {
        if (isUseState(node)) {
          count++;
        }
      });
      return count;
    };
    findContainingNode = (node) => {
      if (!node) {
        return void 0;
      } else if (isReactFunctionalComponent(node) || isReactFunctionalHOC(node) || isCustomHook(node)) {
        return node;
      } else {
        return findContainingNode(node.parent);
      }
    };
  }
});

// src/rules/no-event-handler.js
var no_event_handler_default;
var init_no_event_handler = __esm({
  "src/rules/no-event-handler.js"() {
    init_ast();
    init_ast();
    init_ast();
    no_event_handler_default = {
      meta: {
        type: "suggestion",
        docs: {
          description: "Disallow using state and an effect as an event handler.",
          url: "https://react.dev/learn/you-might-not-need-an-effect#sharing-logic-between-event-handlers"
        },
        schema: [],
        messages: {
          avoidEventHandler: "Avoid using state and effects as an event handler. Instead, call the event handling code directly when the event occurs."
        }
      },
      create: (context) => ({
        CallExpression: (node) => {
          if (!isUseEffect(node) || hasCleanup(node)) return;
          const effectFnRefs = getEffectFnRefs(context, node);
          const depsRefs = getEffectDepsRefs(context, node);
          if (!effectFnRefs || !depsRefs) return;
          findDownstreamNodes(context, node, "IfStatement").filter((ifNode) => !ifNode.alternate).filter(
            (ifNode) => getDownstreamRefs(context, ifNode.test).flatMap((ref) => getUpstreamRefs(context, ref)).notEmptyEvery((ref) => isState(ref))
          ).forEach((ifNode) => {
            context.report({
              node: ifNode.test,
              messageId: "avoidEventHandler"
            });
          });
        }
      })
    };
  }
});

// src/rules/no-pass-live-state-to-parent.js
var no_pass_live_state_to_parent_default;
var init_no_pass_live_state_to_parent = __esm({
  "src/rules/no-pass-live-state-to-parent.js"() {
    init_ast();
    init_ast();
    no_pass_live_state_to_parent_default = {
      meta: {
        type: "suggestion",
        docs: {
          description: "Disallow passing live state to parent components in an effect.",
          url: "https://react.dev/learn/you-might-not-need-an-effect#notifying-parent-components-about-state-changes"
        },
        schema: [],
        messages: {
          avoidPassingLiveStateToParent: "Avoid passing live state to parents in an effect. Instead, lift the state to the parent and pass it down to the child as a prop."
        }
      },
      create: (context) => ({
        CallExpression: (node) => {
          if (!isUseEffect(node)) return;
          const effectFnRefs = getEffectFnRefs(context, node);
          const depsRefs = getEffectDepsRefs(context, node);
          if (!effectFnRefs || !depsRefs) return;
          effectFnRefs.filter((ref) => isPropCallback(context, ref)).filter((ref) => isImmediateCall(ref.identifier)).forEach((ref) => {
            const callExpr = getCallExpr(ref);
            const isStateInArgs = callExpr.arguments.flatMap((arg) => getDownstreamRefs(context, arg)).flatMap((ref2) => getUpstreamRefs(context, ref2)).some((ref2) => isState(ref2));
            if (isStateInArgs) {
              context.report({
                node: callExpr,
                messageId: "avoidPassingLiveStateToParent"
              });
            }
          });
        }
      })
    };
  }
});

// src/rules/no-initialize-state.js
var no_initialize_state_default;
var init_no_initialize_state = __esm({
  "src/rules/no-initialize-state.js"() {
    init_ast();
    init_ast();
    no_initialize_state_default = {
      meta: {
        type: "suggestion",
        docs: {
          description: "Disallow initializing state in an effect.",
          url: "https://tkdodo.eu/blog/avoiding-hydration-mismatches-with-use-sync-external-store"
        },
        schema: [],
        messages: {
          avoidInitializingState: 'Avoid initializing state in an effect. Instead, initialize "{{state}}"\'s `useState()` with "{{arguments}}". For SSR hydration, prefer `useSyncExternalStore()`.'
        }
      },
      create: (context) => ({
        CallExpression: (node) => {
          if (!isUseEffect(node)) return;
          const effectFnRefs = getEffectFnRefs(context, node);
          const depsRefs = getEffectDepsRefs(context, node);
          if (!effectFnRefs || !depsRefs) return;
          if (depsRefs.length > 0) return;
          effectFnRefs.filter((ref) => isStateSetter(context, ref)).filter((ref) => isImmediateCall(ref.identifier)).forEach((ref) => {
            const callExpr = getCallExpr(ref);
            const useStateNode = getUseStateNode(context, ref);
            const stateName = (useStateNode.id.elements[0] ?? useStateNode.id.elements[1])?.name;
            const argumentText = callExpr.arguments[0] ? context.sourceCode.getText(callExpr.arguments[0]) : "undefined";
            context.report({
              node: getCallExpr(ref),
              messageId: "avoidInitializingState",
              data: { state: stateName, arguments: argumentText }
            });
          });
        }
      })
    };
  }
});

// src/rules/no-chain-state-updates.js
var no_chain_state_updates_default;
var init_no_chain_state_updates = __esm({
  "src/rules/no-chain-state-updates.js"() {
    init_ast();
    init_ast();
    no_chain_state_updates_default = {
      meta: {
        type: "suggestion",
        docs: {
          description: "Disallow chaining state changes in an effect.",
          url: "https://react.dev/learn/you-might-not-need-an-effect#chains-of-computations"
        },
        schema: [],
        messages: {
          avoidChainingStateUpdates: "Avoid chaining state changes. When possible, update all relevant state simultaneously."
        }
      },
      create: (context) => ({
        CallExpression: (node) => {
          if (!isUseEffect(node) || hasCleanup(node)) return;
          const effectFnRefs = getEffectFnRefs(context, node);
          const depsRefs = getEffectDepsRefs(context, node);
          if (!effectFnRefs || !depsRefs) return;
          const isAllDepsState = depsRefs.flatMap((ref) => getUpstreamRefs(context, ref)).notEmptyEvery((ref) => isState(ref));
          effectFnRefs.filter((ref) => isStateSetter(context, ref)).filter((ref) => isImmediateCall(ref.identifier)).forEach((ref) => {
            const callExpr = getCallExpr(ref);
            if (isAllDepsState && isArgsAllLiterals(context, callExpr)) {
              context.report({
                node: callExpr,
                messageId: "avoidChainingStateUpdates"
              });
            }
          });
        }
      })
    };
  }
});

// src/rules/no-derived-state.js
var no_derived_state_default, countCalls;
var init_no_derived_state = __esm({
  "src/rules/no-derived-state.js"() {
    init_ast();
    init_ast();
    no_derived_state_default = {
      meta: {
        type: "suggestion",
        docs: {
          description: "Disallow storing derived state in an effect.",
          url: "https://react.dev/learn/you-might-not-need-an-effect#updating-state-based-on-props-or-state"
        },
        schema: [],
        messages: {
          avoidDerivedState: 'Avoid storing derived state. Compute "{{state}}" directly during render, optionally with `useMemo` if it\'s expensive.',
          avoidSingleSetter: 'Avoid storing derived state. "{{state}}" is only set here, and thus could be computed directly during render.'
        }
      },
      create: (context) => ({
        CallExpression: (node) => {
          if (!isUseEffect(node) || hasCleanup(node)) return;
          const effectFnRefs = getEffectFnRefs(context, node);
          const depsRefs = getEffectDepsRefs(context, node);
          if (!effectFnRefs || !depsRefs) return;
          effectFnRefs.filter((ref) => isStateSetter(context, ref)).filter((ref) => isImmediateCall(ref.identifier)).forEach((ref) => {
            const callExpr = getCallExpr(ref);
            const useStateNode = getUseStateNode(context, ref);
            const stateName = (useStateNode.id.elements[0] ?? useStateNode.id.elements[1])?.name;
            const argsUpstreamRefs = callExpr.arguments.flatMap((arg) => getDownstreamRefs(context, arg)).flatMap((ref2) => getUpstreamRefs(context, ref2));
            const depsUpstreamRefs = depsRefs.flatMap(
              (ref2) => getUpstreamRefs(context, ref2)
            );
            const isAllArgsInternal = argsUpstreamRefs.notEmptyEvery(
              (ref2) => isState(ref2) || isProp(ref2)
            );
            const isAllArgsInDeps = argsUpstreamRefs.notEmptyEvery(
              (argRef) => depsUpstreamRefs.some(
                (depRef) => argRef.resolved.name === depRef.resolved.name
              )
            );
            const isValueAlwaysInSync = isAllArgsInDeps && countCalls(ref) === 1;
            if (isAllArgsInternal) {
              context.report({
                node: callExpr,
                messageId: "avoidDerivedState",
                data: { state: stateName }
              });
            } else if (isValueAlwaysInSync) {
              context.report({
                node: callExpr,
                messageId: "avoidSingleSetter",
                data: { state: stateName }
              });
            }
          });
        }
      })
    };
    countCalls = (ref) => ref.resolved.references.filter(
      (ref2) => ref2.identifier.parent.type === "CallExpression"
    ).length;
  }
});

// src/rules/no-pass-data-to-parent.js
var no_pass_data_to_parent_default;
var init_no_pass_data_to_parent = __esm({
  "src/rules/no-pass-data-to-parent.js"() {
    init_ast();
    init_ast();
    no_pass_data_to_parent_default = {
      meta: {
        type: "suggestion",
        docs: {
          description: "Disallow passing data to parents in an effect.",
          url: "https://react.dev/learn/you-might-not-need-an-effect#passing-data-to-the-parent"
        },
        schema: [],
        messages: {
          avoidPassingDataToParent: "Avoid passing data to parents in an effect. Instead, let the parent fetch the data itself and pass it down to the child as a prop."
        }
      },
      create: (context) => ({
        CallExpression: (node) => {
          if (!isUseEffect(node) || hasCleanup(node)) return;
          const effectFnRefs = getEffectFnRefs(context, node);
          const depsRefs = getEffectDepsRefs(context, node);
          if (!effectFnRefs || !depsRefs) return;
          effectFnRefs.filter((ref) => isPropCallback(context, ref)).filter((ref) => isImmediateCall(ref.identifier)).forEach((ref) => {
            const callExpr = getCallExpr(ref);
            const isAllData = callExpr.arguments.length & callExpr.arguments.flatMap((arg) => getDownstreamRefs(context, arg)).flatMap((ref2) => getUpstreamRefs(context, ref2)).notEmptyEvery(
              (ref2) => !isState(ref2) && !isProp(ref2) && !isRef(ref2)
            );
            if (isAllData) {
              context.report({
                node: callExpr,
                messageId: "avoidPassingDataToParent"
              });
            }
          });
        }
      })
    };
  }
});

// src/rules/no-manage-parent.js
var no_manage_parent_default;
var init_no_manage_parent = __esm({
  "src/rules/no-manage-parent.js"() {
    init_ast();
    init_ast();
    no_manage_parent_default = {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow effects that only use props."
        },
        schema: [],
        messages: {
          avoidManagingParent: "This effect only uses props. Consider lifting the logic up to the parent."
        }
      },
      create: (context) => ({
        CallExpression: (node) => {
          if (!isUseEffect(node)) return;
          const effectFnRefs = getEffectFnRefs(context, node);
          const depsRefs = getEffectDepsRefs(context, node);
          if (!effectFnRefs || !depsRefs) return;
          if (effectFnRefs.length === 0) return;
          const isAllProps = effectFnRefs.concat(depsRefs).flatMap((ref) => getUpstreamRefs(context, ref)).notEmptyEvery((ref) => isProp(ref));
          if (isAllProps) {
            context.report({
              node,
              messageId: "avoidManagingParent"
            });
          }
        }
      })
    };
  }
});

// src/rules/no-pass-ref-to-parent.js
var no_pass_ref_to_parent_default;
var init_no_pass_ref_to_parent = __esm({
  "src/rules/no-pass-ref-to-parent.js"() {
    init_ast();
    init_ast();
    no_pass_ref_to_parent_default = {
      meta: {
        type: "suggestion",
        docs: {
          description: "Disallow passing refs, or data from callbacks registered on them, to parents in an effect. Use `forwardRef` instead.",
          url: "https://react.dev/reference/react/forwardRef"
        },
        schema: [],
        messages: {
          avoidPassingRefToParent: "Avoid passing refs to parents in an effect. Use `forwardRef` instead.",
          avoidPropCallbackInRefCallback: "Avoid calling props inside callbacks registered on refs in an effect. Use `forwardRef` to register the callback in the parent instead."
        }
      },
      create: (context) => ({
        CallExpression: (node) => {
          if (!isUseEffect(node) || hasCleanup(node)) return;
          const effectFnRefs = getEffectFnRefs(context, node);
          const depsRefs = getEffectDepsRefs(context, node);
          if (!effectFnRefs || !depsRefs) return;
          effectFnRefs.filter((ref) => isPropCallback(context, ref)).forEach((ref) => {
            const callExpr = getCallExpr(ref);
            const hasRefArg = callExpr.arguments.flatMap((arg) => getDownstreamRefs(context, arg)).flatMap((ref2) => getUpstreamRefs(context, ref2)).some((ref2) => isRef(ref2));
            if (hasRefArg) {
              context.report({
                node: callExpr,
                messageId: "avoidPassingRefToParent"
              });
            }
          });
          effectFnRefs.filter((ref) => isRefCall(context, ref)).forEach((ref) => {
            const callExpr = getCallExpr(ref);
            const passesCallbackDataToParent = callExpr.arguments.flatMap((arg) => getDownstreamRefs(context, arg)).flatMap((ref2) => getUpstreamRefs(context, ref2)).some((ref2) => isPropCallback(context, ref2));
            if (passesCallbackDataToParent) {
              context.report({
                node: getCallExpr(ref),
                messageId: "avoidPropCallbackInRefCallback"
              });
            }
          });
        }
      })
    };
  }
});

// src/index.js
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
var import_globals, plugin, recommendedRules, languageOptions, index_default;
var init_index = __esm({
  "src/index.js"() {
    init_no_empty_effect();
    init_no_adjust_state_on_prop_change();
    init_no_reset_all_state_on_prop_change();
    init_no_event_handler();
    init_no_pass_live_state_to_parent();
    init_no_initialize_state();
    init_no_chain_state_updates();
    init_no_derived_state();
    init_no_pass_data_to_parent();
    init_no_manage_parent();
    init_no_pass_ref_to_parent();
    import_globals = __toESM(require("globals"), 1);
    plugin = {
      meta: {
        name: "react-you-might-not-need-an-effect"
      },
      configs: {},
      rules: {
        "no-empty-effect": no_empty_effect_default,
        "no-adjust-state-on-prop-change": no_adjust_state_on_prop_change_default,
        "no-reset-all-state-on-prop-change": no_reset_all_state_on_prop_change_default,
        "no-event-handler": no_event_handler_default,
        "no-pass-live-state-to-parent": no_pass_live_state_to_parent_default,
        "no-pass-data-to-parent": no_pass_data_to_parent_default,
        "no-manage-parent": no_manage_parent_default,
        "no-pass-ref-to-parent": no_pass_ref_to_parent_default,
        "no-initialize-state": no_initialize_state_default,
        "no-chain-state-updates": no_chain_state_updates_default,
        "no-derived-state": no_derived_state_default
      }
    };
    recommendedRules = Object.keys(plugin.rules).reduce((acc, ruleName) => {
      acc[plugin.meta.name + "/" + ruleName] = "warn";
      return acc;
    }, {});
    languageOptions = {
      globals: {
        // Required so we can resolve global references to their upstream global variables
        ...import_globals.default.browser
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      }
    };
    Object.assign(plugin.configs, {
      // flat config format
      recommended: {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        plugins: {
          // Object.assign above so we can reference `plugin` here
          [plugin.meta.name]: plugin
        },
        rules: recommendedRules,
        languageOptions
      },
      "legacy-recommended": {
        plugins: [plugin.meta.name],
        rules: recommendedRules,
        ...languageOptions
      }
    });
    index_default = plugin;
    Array.prototype.notEmptyEvery = function(predicate) {
      return this.length > 0 && this.every(predicate);
    };
  }
});

// src/index.cjs
module.exports = (init_index(), __toCommonJS(index_exports)).default;
//# sourceMappingURL=index.cjs.map
