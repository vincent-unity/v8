// Copyright 2009 the V8 project authors. All rights reserved.
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//     * Redistributions of source code must retain the above copyright
//       notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above
//       copyright notice, this list of conditions and the following
//       disclaimer in the documentation and/or other materials provided
//       with the distribution.
//     * Neither the name of Google Inc. nor the names of its
//       contributors may be used to endorse or promote products derived
//       from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

import { CodeMap, CodeEntry } from "./codemap.mjs";
import { ConsArray } from "./consarray.mjs";

// TODO: move to separate modules
export class SourcePosition {
  constructor(script, line, column) {
    this.script = script;
    this.line = line;
    this.column = column;
    this.entries = [];
  }
  addEntry(entry) {
    this.entries.push(entry);
  }
}

export class Script {
  constructor(id, name, source) {
    this.id = id;
    this.name = name;
    this.source = source;
    this.sourcePositions = [];
    // Map<line, Map<column, SourcePosition>>
    this.lineToColumn = new Map();
  }

  addSourcePosition(line, column, entry) {
    let sourcePosition = this.lineToColumn.get(line)?.get(column);
    if (sourcePosition === undefined) {
      sourcePosition = new SourcePosition(this, line, column, )
      this._addSourcePosition(line, column, sourcePosition);
    }
    sourcePosition.addEntry(entry);
    return sourcePosition;
  }

  _addSourcePosition(line, column, sourcePosition) {
    let columnToSourcePosition;
    if (this.lineToColumn.has(line)) {
      columnToSourcePosition = this.lineToColumn.get(line);
    } else {
      columnToSourcePosition = new Map();
      this.lineToColumn.set(line, columnToSourcePosition);
    }
    this.sourcePositions.push(sourcePosition);
    columnToSourcePosition.set(column, sourcePosition);
  }
}

/**
 * Creates a profile object for processing profiling-related events
 * and calculating function execution times.
 *
 * @constructor
 */
export class Profile {
  codeMap_ = new CodeMap();
  topDownTree_ = new CallTree();
  bottomUpTree_ = new CallTree();
  c_entries_ = {};
  ticks_ = [];
  scripts_ = [];
  urlToScript_ = new Map();

  /**
   * Returns whether a function with the specified name must be skipped.
   * Should be overriden by subclasses.
   *
   * @param {string} name Function name.
   */
  skipThisFunction(name) {
    return false;
  }

  /**
   * Enum for profiler operations that involve looking up existing
   * code entries.
   *
   * @enum {number}
   */
  static Operation = {
    MOVE: 0,
    DELETE: 1,
    TICK: 2
  }

  /**
   * Enum for code state regarding its dynamic optimization.
   *
   * @enum {number}
   */
  static CodeState = {
    COMPILED: 0,
    OPTIMIZABLE: 1,
    OPTIMIZED: 2
  }

  /**
   * Called whenever the specified operation has failed finding a function
   * containing the specified address. Should be overriden by subclasses.
   * See the Profile.Operation enum for the list of
   * possible operations.
   *
   * @param {number} operation Operation.
   * @param {number} addr Address of the unknown code.
   * @param {number} opt_stackPos If an unknown address is encountered
   *     during stack strace processing, specifies a position of the frame
   *     containing the address.
   */
  handleUnknownCode(operation, addr, opt_stackPos) {}

  /**
   * Registers a library.
   *
   * @param {string} name Code entry name.
   * @param {number} startAddr Starting address.
   * @param {number} endAddr Ending address.
   */
  addLibrary(name, startAddr, endAddr) {
    var entry = new CodeEntry(endAddr - startAddr, name, 'SHARED_LIB');
    this.codeMap_.addLibrary(startAddr, entry);
    return entry;
  }

  /**
   * Registers statically compiled code entry.
   *
   * @param {string} name Code entry name.
   * @param {number} startAddr Starting address.
   * @param {number} endAddr Ending address.
   */
  addStaticCode(name, startAddr, endAddr) {
      var entry = new CodeEntry(endAddr - startAddr, name, 'CPP');
    this.codeMap_.addStaticCode(startAddr, entry);
    return entry;
  }

  /**
   * Registers dynamic (JIT-compiled) code entry.
   *
   * @param {string} type Code entry type.
   * @param {string} name Code entry name.
   * @param {number} start Starting address.
   * @param {number} size Code entry size.
   */
  addCode(type, name, timestamp, start, size) {
    var entry = new DynamicCodeEntry(size, type, name);
    this.codeMap_.addCode(start, entry);
    return entry;
  }

  /**
   * Registers dynamic (JIT-compiled) code entry.
   *
   * @param {string} type Code entry type.
   * @param {string} name Code entry name.
   * @param {number} start Starting address.
   * @param {number} size Code entry size.
   * @param {number} funcAddr Shared function object address.
   * @param {Profile.CodeState} state Optimization state.
   */
  addFuncCode(type, name, timestamp, start, size, funcAddr, state) {
    // As code and functions are in the same address space,
    // it is safe to put them in a single code map.
    var func = this.codeMap_.findDynamicEntryByStartAddress(funcAddr);
    if (!func) {
      func = new FunctionEntry(name);
      this.codeMap_.addCode(funcAddr, func);
    } else if (func.name !== name) {
      // Function object has been overwritten with a new one.
      func.name = name;
    }
    var entry = this.codeMap_.findDynamicEntryByStartAddress(start);
    if (entry) {
      if (entry.size === size && entry.func === func) {
        // Entry state has changed.
        entry.state = state;
      } else {
        this.codeMap_.deleteCode(start);
        entry = null;
      }
    }
    if (!entry) {
      entry = new DynamicFuncCodeEntry(size, type, func, state);
      this.codeMap_.addCode(start, entry);
    }
    return entry;
  }

  /**
   * Reports about moving of a dynamic code entry.
   *
   * @param {number} from Current code entry address.
   * @param {number} to New code entry address.
   */
  moveCode(from, to) {
    try {
      this.codeMap_.moveCode(from, to);
    } catch (e) {
      this.handleUnknownCode(Profile.Operation.MOVE, from);
    }
  }

  deoptCode(  timestamp, code, inliningId, scriptOffset, bailoutType,
    sourcePositionText, deoptReasonText) {
  }

  /**
   * Reports about deletion of a dynamic code entry.
   *
   * @param {number} start Starting address.
   */
  deleteCode(start) {
    try {
      this.codeMap_.deleteCode(start);
    } catch (e) {
      this.handleUnknownCode(Profile.Operation.DELETE, start);
    }
  }

  /**
   * Adds source positions for given code.
   */
  addSourcePositions(start, script, startPos, endPos, sourcePositions,
        inliningPositions, inlinedFunctions) {
    // CLI does not need source code => ignore.
  }

  /**
   * Adds script source code.
   */
  addScriptSource(id, url, source) {
    const script = new Script(id, url, source);
    this.scripts_[id] = script;
    this.urlToScript_.set(url, script);
  }

  /**
   * Adds script source code.
   */
  getScript(url) {
    return this.urlToScript_.get(url);
  }

  /**
   * Reports about moving of a dynamic code entry.
   *
   * @param {number} from Current code entry address.
   * @param {number} to New code entry address.
   */
  moveFunc(from, to) {
    if (this.codeMap_.findDynamicEntryByStartAddress(from)) {
      this.codeMap_.moveCode(from, to);
    }
  }

  /**
   * Retrieves a code entry by an address.
   *
   * @param {number} addr Entry address.
   */
  findEntry(addr) {
    return this.codeMap_.findEntry(addr);
  }

  /**
   * Records a tick event. Stack must contain a sequence of
   * addresses starting with the program counter value.
   *
   * @param {Array<number>} stack Stack sample.
   */
  recordTick(time_ns, vmState, stack) {
    var processedStack = this.resolveAndFilterFuncs_(stack);
    this.bottomUpTree_.addPath(processedStack);
    processedStack.reverse();
    this.topDownTree_.addPath(processedStack);
  }

  /**
   * Translates addresses into function names and filters unneeded
   * functions.
   *
   * @param {Array<number>} stack Stack sample.
   */
  resolveAndFilterFuncs_(stack) {
    var result = [];
    var last_seen_c_function = '';
    var look_for_first_c_function = false;
    for (var i = 0; i < stack.length; ++i) {
      var entry = this.codeMap_.findEntry(stack[i]);
      if (entry) {
        var name = entry.getName();
        if (i === 0 && (entry.type === 'CPP' || entry.type === 'SHARED_LIB')) {
          look_for_first_c_function = true;
        }
        if (look_for_first_c_function && entry.type === 'CPP') {
          last_seen_c_function = name;
        }
        if (!this.skipThisFunction(name)) {
          result.push(name);
        }
      } else {
        this.handleUnknownCode(Profile.Operation.TICK, stack[i], i);
        if (i === 0) result.push("UNKNOWN");
      }
      if (look_for_first_c_function &&
        i > 0 &&
        (!entry || entry.type !== 'CPP') &&
        last_seen_c_function !== '') {
        if (this.c_entries_[last_seen_c_function] === undefined) {
          this.c_entries_[last_seen_c_function] = 0;
        }
        this.c_entries_[last_seen_c_function]++;
        look_for_first_c_function = false;  // Found it, we're done.
      }
    }
    return result;
  }

  /**
   * Performs a BF traversal of the top down call graph.
   *
   * @param {function(CallTreeNode)} f Visitor function.
   */
  traverseTopDownTree(f) {
    this.topDownTree_.traverse(f);
  }

  /**
   * Performs a BF traversal of the bottom up call graph.
   *
   * @param {function(CallTreeNode)} f Visitor function.
   */
  traverseBottomUpTree(f) {
    this.bottomUpTree_.traverse(f);
  }

  /**
   * Calculates a top down profile for a node with the specified label.
   * If no name specified, returns the whole top down calls tree.
   *
   * @param {string} opt_label Node label.
   */
  getTopDownProfile(opt_label) {
    return this.getTreeProfile_(this.topDownTree_, opt_label);
  }

  /**
   * Calculates a bottom up profile for a node with the specified label.
   * If no name specified, returns the whole bottom up calls tree.
   *
   * @param {string} opt_label Node label.
   */
  getBottomUpProfile(opt_label) {
    return this.getTreeProfile_(this.bottomUpTree_, opt_label);
  }

  /**
   * Helper function for calculating a tree profile.
   *
   * @param {Profile.CallTree} tree Call tree.
   * @param {string} opt_label Node label.
   */
  getTreeProfile_(tree, opt_label) {
    if (!opt_label) {
      tree.computeTotalWeights();
      return tree;
    } else {
      var subTree = tree.cloneSubtree(opt_label);
      subTree.computeTotalWeights();
      return subTree;
    }
  }

  /**
   * Calculates a flat profile of callees starting from a node with
   * the specified label. If no name specified, starts from the root.
   *
   * @param {string} opt_label Starting node label.
   */
  getFlatProfile(opt_label) {
    var counters = new CallTree();
    var rootLabel = opt_label || CallTree.ROOT_NODE_LABEL;
    var precs = {};
    precs[rootLabel] = 0;
    var root = counters.findOrAddChild(rootLabel);

    this.topDownTree_.computeTotalWeights();
    this.topDownTree_.traverseInDepth(
      function onEnter(node) {
        if (!(node.label in precs)) {
          precs[node.label] = 0;
        }
        var nodeLabelIsRootLabel = node.label == rootLabel;
        if (nodeLabelIsRootLabel || precs[rootLabel] > 0) {
          if (precs[rootLabel] == 0) {
            root.selfWeight += node.selfWeight;
            root.totalWeight += node.totalWeight;
          } else {
            var rec = root.findOrAddChild(node.label);
            rec.selfWeight += node.selfWeight;
            if (nodeLabelIsRootLabel || precs[node.label] == 0) {
              rec.totalWeight += node.totalWeight;
            }
          }
          precs[node.label]++;
        }
      },
      function onExit(node) {
        if (node.label == rootLabel || precs[rootLabel] > 0) {
          precs[node.label]--;
        }
      },
      null);

    if (!opt_label) {
      // If we have created a flat profile for the whole program, we don't
      // need an explicit root in it. Thus, replace the counters tree
      // root with the node corresponding to the whole program.
      counters.root_ = root;
    } else {
      // Propagate weights so percents can be calculated correctly.
      counters.getRoot().selfWeight = root.selfWeight;
      counters.getRoot().totalWeight = root.totalWeight;
    }
    return counters;
  }

  getCEntryProfile() {
    var result = [new CEntryNode("TOTAL", 0)];
    var total_ticks = 0;
    for (var f in this.c_entries_) {
      var ticks = this.c_entries_[f];
      total_ticks += ticks;
      result.push(new CEntryNode(f, ticks));
    }
    result[0].ticks = total_ticks;  // Sorting will keep this at index 0.
    result.sort(function (n1, n2) {
      return n2.ticks - n1.ticks || (n2.name < n1.name ? -1 : 1)
    });
    return result;
  }


  /**
   * Cleans up function entries that are not referenced by code entries.
   */
  cleanUpFuncEntries() {
    var referencedFuncEntries = [];
    var entries = this.codeMap_.getAllDynamicEntriesWithAddresses();
    for (var i = 0, l = entries.length; i < l; ++i) {
      if (entries[i][1].constructor === FunctionEntry) {
        entries[i][1].used = false;
      }
    }
    for (var i = 0, l = entries.length; i < l; ++i) {
      if ("func" in entries[i][1]) {
        entries[i][1].func.used = true;
      }
    }
    for (var i = 0, l = entries.length; i < l; ++i) {
      if (entries[i][1].constructor === FunctionEntry &&
        !entries[i][1].used) {
        this.codeMap_.deleteCode(entries[i][0]);
      }
    }
  }
}

class CEntryNode {
  constructor(name, ticks) {
    this.name = name;
    this.ticks = ticks;
  }
}


/**
 * Creates a dynamic code entry.
 *
 * @param {number} size Code size.
 * @param {string} type Code type.
 * @param {string} name Function name.
 * @constructor
 */
class DynamicCodeEntry extends CodeEntry {
  constructor(size, type, name) {
    super(size, name, type);
  }
  
  getName() {
    return this.type + ': ' + this.name;
  }

  /**
   * Returns raw node name (without type decoration).
   */
  getRawName() {
    return this.name;
  }

  isJSFunction() {
    return false;
  }

  toString() {
    return this.getName() + ': ' + this.size.toString(16);
  }
}


/**
 * Creates a dynamic code entry.
 *
 * @param {number} size Code size.
 * @param {string} type Code type.
 * @param {FunctionEntry} func Shared function entry.
 * @param {Profile.CodeState} state Code optimization state.
 * @constructor
 */
class DynamicFuncCodeEntry extends CodeEntry {
  constructor(size, type, func, state) {
    super(size, '', type);
    this.func = func;
    this.state = state;
  }

  static STATE_PREFIX = ["", "~", "*"];
  getState() {
    return DynamicFuncCodeEntry.STATE_PREFIX[this.state];
  }
  
  getName() {
    var name = this.func.getName();
    return this.type + ': ' + this.getState() + name;
  }

  /**
   * Returns raw node name (without type decoration).
   */
  getRawName() {
    return this.func.getName();
  }

  isJSFunction() {
    return true;
  }

  toString() {
    return this.getName() + ': ' + this.size.toString(16);
  }
}

/**
 * Creates a shared function object entry.
 *
 * @param {string} name Function name.
 * @constructor
 */
class FunctionEntry extends CodeEntry {
  constructor(name) {
    super(0, name);
  }

  /**
   * Returns node name.
   */
  getName() {
    var name = this.name;
    if (name.length == 0) {
      name = '<anonymous>';
    } else if (name.charAt(0) == ' ') {
      // An anonymous function with location: " aaa.js:10".
      name = '<anonymous>' + name;
    }
    return name;
  }
}

/**
 * Constructs a call graph.
 *
 * @constructor
 */
class CallTree {
  root_ = new CallTreeNode(CallTree.ROOT_NODE_LABEL);
  totalsComputed_ = false;

  /**
   * The label of the root node.
   */
  static ROOT_NODE_LABEL = '';

  /**
   * Returns the tree root.
   */
  getRoot() {
    return this.root_;
  }

  /**
   * Adds the specified call path, constructing nodes as necessary.
   *
   * @param {Array<string>} path Call path.
   */
  addPath(path) {
    if (path.length == 0) {
      return;
    }
    var curr = this.root_;
    for (var i = 0; i < path.length; ++i) {
      curr = curr.findOrAddChild(path[i]);
    }
    curr.selfWeight++;
    this.totalsComputed_ = false;
  }

  /**
   * Finds an immediate child of the specified parent with the specified
   * label, creates a child node if necessary. If a parent node isn't
   * specified, uses tree root.
   *
   * @param {string} label Child node label.
   */
  findOrAddChild(label) {
    return this.root_.findOrAddChild(label);
  }

  /**
   * Creates a subtree by cloning and merging all subtrees rooted at nodes
   * with a given label. E.g. cloning the following call tree on label 'A'
   * will give the following result:
   *
   *           <A>--<B>                                     <B>
   *          /                                            /
   *     <root>             == clone on 'A' ==>  <root>--<A>
   *          \                                            \
   *           <C>--<A>--<D>                                <D>
   *
   * And <A>'s selfWeight will be the sum of selfWeights of <A>'s from the
   * source call tree.
   *
   * @param {string} label The label of the new root node.
   */
  cloneSubtree(label) {
    var subTree = new CallTree();
    this.traverse((node, parent) => {
      if (!parent && node.label != label) {
        return null;
      }
      var child = (parent ? parent : subTree).findOrAddChild(node.label);
      child.selfWeight += node.selfWeight;
      return child;
    });
    return subTree;
  }

  /**
   * Computes total weights in the call graph.
   */
  computeTotalWeights() {
    if (this.totalsComputed_) return;
    this.root_.computeTotalWeight();
    this.totalsComputed_ = true;
  }

  /**
   * Traverses the call graph in preorder. This function can be used for
   * building optionally modified tree clones. This is the boilerplate code
   * for this scenario:
   *
   * callTree.traverse(function(node, parentClone) {
   *   var nodeClone = cloneNode(node);
   *   if (parentClone)
   *     parentClone.addChild(nodeClone);
   *   return nodeClone;
   * });
   *
   * @param {function(CallTreeNode, *)} f Visitor function.
   *    The second parameter is the result of calling 'f' on the parent node.
   */
  traverse(f) {
    var pairsToProcess = new ConsArray();
    pairsToProcess.concat([{ node: this.root_, param: null }]);
    while (!pairsToProcess.atEnd()) {
      var pair = pairsToProcess.next();
      var node = pair.node;
      var newParam = f(node, pair.param);
      var morePairsToProcess = [];
      node.forEachChild((child) => {
        morePairsToProcess.push({ node: child, param: newParam });
      });
      pairsToProcess.concat(morePairsToProcess);
    }
  }

  /**
   * Performs an indepth call graph traversal.
   *
   * @param {function(CallTreeNode)} enter A function called
   *     prior to visiting node's children.
   * @param {function(CallTreeNode)} exit A function called
   *     after visiting node's children.
   */
    traverseInDepth(enter, exit) {
    function traverse(node) {
      enter(node);
      node.forEachChild(traverse);
      exit(node);
    }
    traverse(this.root_);
  }
}


/**
 * Constructs a call graph node.
 *
 * @param {string} label Node label.
 * @param {CallTreeNode} opt_parent Node parent.
 */
 class CallTreeNode {
  /**
   * Node self weight (how many times this node was the last node in
   * a call path).
   * @type {number}
   */
  selfWeight = 0;

  /**
   * Node total weight (includes weights of all children).
   * @type {number}
   */
  totalWeight = 0;
  children = {};

  constructor(label, opt_parent) {
    this.label = label;
    this.parent = opt_parent;
  }


  /**
   * Adds a child node.
   *
   * @param {string} label Child node label.
   */
  addChild(label) {
    var child = new CallTreeNode(label, this);
    this.children[label] = child;
    return child;
  }

  /**
   * Computes node's total weight.
   */
  computeTotalWeight() {
    var totalWeight = this.selfWeight;
    this.forEachChild(function (child) {
      totalWeight += child.computeTotalWeight();
    });
    return this.totalWeight = totalWeight;
  }

  /**
   * Returns all node's children as an array.
   */
  exportChildren() {
    var result = [];
    this.forEachChild(function (node) { result.push(node); });
    return result;
  }

  /**
   * Finds an immediate child with the specified label.
   *
   * @param {string} label Child node label.
   */
  findChild(label) {
    return this.children[label] || null;
  }

  /**
   * Finds an immediate child with the specified label, creates a child
   * node if necessary.
   *
   * @param {string} label Child node label.
   */
  findOrAddChild(label) {
    return this.findChild(label) || this.addChild(label);
  }

  /**
   * Calls the specified function for every child.
   *
   * @param {function(CallTreeNode)} f Visitor function.
   */
  forEachChild(f) {
    for (var c in this.children) {
      f(this.children[c]);
    }
  }

  /**
   * Walks up from the current node up to the call tree root.
   *
   * @param {function(CallTreeNode)} f Visitor function.
   */
  walkUpToRoot(f) {
    for (var curr = this; curr != null; curr = curr.parent) {
      f(curr);
    }
  }

  /**
   * Tries to find a node with the specified path.
   *
   * @param {Array<string>} labels The path.
   * @param {function(CallTreeNode)} opt_f Visitor function.
   */
  descendToChild(labels, opt_f) {
    for (var pos = 0, curr = this; pos < labels.length && curr != null; pos++) {
      var child = curr.findChild(labels[pos]);
      if (opt_f) {
        opt_f(child, pos);
      }
      curr = child;
    }
    return curr;
  }
}

export function JsonProfile() {
  this.codeMap_ = new CodeMap();
  this.codeEntries_ = [];
  this.functionEntries_ = [];
  this.ticks_ = [];
  this.scripts_ = [];
}

JsonProfile.prototype.addLibrary = function (
  name, startAddr, endAddr) {
  var entry = new CodeEntry(
    endAddr - startAddr, name, 'SHARED_LIB');
  this.codeMap_.addLibrary(startAddr, entry);

  entry.codeId = this.codeEntries_.length;
  this.codeEntries_.push({ name: entry.name, type: entry.type });
  return entry;
};

JsonProfile.prototype.addStaticCode = function (
  name, startAddr, endAddr) {
  var entry = new CodeEntry(
    endAddr - startAddr, name, 'CPP');
  this.codeMap_.addStaticCode(startAddr, entry);

  entry.codeId = this.codeEntries_.length;
  this.codeEntries_.push({ name: entry.name, type: entry.type });
  return entry;
};

JsonProfile.prototype.addCode = function (
  kind, name, timestamp, start, size) {
  let codeId = this.codeEntries_.length;
  // Find out if we have a static code entry for the code. If yes, we will
  // make sure it is written to the JSON file just once.
  let staticEntry = this.codeMap_.findAddress(start);
  if (staticEntry && staticEntry.entry.type === 'CPP') {
    codeId = staticEntry.entry.codeId;
  }

  var entry = new CodeEntry(size, name, 'CODE');
  this.codeMap_.addCode(start, entry);

  entry.codeId = codeId;
  this.codeEntries_[codeId] = {
    name: entry.name,
    timestamp: timestamp,
    type: entry.type,
    kind: kind
  };

  return entry;
};

JsonProfile.prototype.addFuncCode = function (
  kind, name, timestamp, start, size, funcAddr, state) {
  // As code and functions are in the same address space,
  // it is safe to put them in a single code map.
  var func = this.codeMap_.findDynamicEntryByStartAddress(funcAddr);
  if (!func) {
    var func = new CodeEntry(0, name, 'SFI');
    this.codeMap_.addCode(funcAddr, func);

    func.funcId = this.functionEntries_.length;
    this.functionEntries_.push({ name: name, codes: [] });
  } else if (func.name !== name) {
    // Function object has been overwritten with a new one.
    func.name = name;

    func.funcId = this.functionEntries_.length;
    this.functionEntries_.push({ name: name, codes: [] });
  }
  // TODO(jarin): Insert the code object into the SFI's code list.
  var entry = this.codeMap_.findDynamicEntryByStartAddress(start);
  if (entry) {
    if (entry.size === size && entry.func === func) {
      // Entry state has changed.
      entry.state = state;
    } else {
      this.codeMap_.deleteCode(start);
      entry = null;
    }
  }
  if (!entry) {
    entry = new CodeEntry(size, name, 'JS');
    this.codeMap_.addCode(start, entry);

    entry.codeId = this.codeEntries_.length;

    this.functionEntries_[func.funcId].codes.push(entry.codeId);

    if (state === 0) {
      kind = "Builtin";
    } else if (state === 1) {
      kind = "Unopt";
    } else if (state === 2) {
      kind = "Opt";
    }

    this.codeEntries_.push({
      name: entry.name,
      type: entry.type,
      kind: kind,
      func: func.funcId,
      tm: timestamp
    });
  }
  return entry;
};

JsonProfile.prototype.moveCode = function (from, to) {
  try {
    this.codeMap_.moveCode(from, to);
  } catch (e) {
    printErr("Move: unknown source " + from);
  }
};

JsonProfile.prototype.addSourcePositions = function (
  start, script, startPos, endPos, sourcePositions, inliningPositions,
  inlinedFunctions) {
  var entry = this.codeMap_.findDynamicEntryByStartAddress(start);
  if (!entry) return;
  var codeId = entry.codeId;

  // Resolve the inlined functions list.
  if (inlinedFunctions.length > 0) {
    inlinedFunctions = inlinedFunctions.substring(1).split("S");
    for (var i = 0; i < inlinedFunctions.length; i++) {
      var funcAddr = parseInt(inlinedFunctions[i]);
      var func = this.codeMap_.findDynamicEntryByStartAddress(funcAddr);
      if (!func || func.funcId === undefined) {
        printErr("Could not find function " + inlinedFunctions[i]);
        inlinedFunctions[i] = null;
      } else {
        inlinedFunctions[i] = func.funcId;
      }
    }
  } else {
    inlinedFunctions = [];
  }

  this.codeEntries_[entry.codeId].source = {
    script: script,
    start: startPos,
    end: endPos,
    positions: sourcePositions,
    inlined: inliningPositions,
    fns: inlinedFunctions
  };
};

JsonProfile.prototype.addScriptSource = function (id, url, source) {
  this.scripts_[id] = new Script(id, url, source);
};

JsonProfile.prototype.deoptCode = function (
  timestamp, code, inliningId, scriptOffset, bailoutType,
  sourcePositionText, deoptReasonText) {
  let entry = this.codeMap_.findDynamicEntryByStartAddress(code);
  if (entry) {
    let codeId = entry.codeId;
    if (!this.codeEntries_[codeId].deopt) {
      // Only add the deopt if there was no deopt before.
      // The subsequent deoptimizations should be lazy deopts for
      // other on-stack activations.
      this.codeEntries_[codeId].deopt = {
        tm: timestamp,
        inliningId: inliningId,
        scriptOffset: scriptOffset,
        posText: sourcePositionText,
        reason: deoptReasonText,
        bailoutType: bailoutType
      };
    }
  }
};

JsonProfile.prototype.deleteCode = function (start) {
  try {
    this.codeMap_.deleteCode(start);
  } catch (e) {
    printErr("Delete: unknown address " + start);
  }
};

JsonProfile.prototype.moveFunc = function (from, to) {
  if (this.codeMap_.findDynamicEntryByStartAddress(from)) {
    this.codeMap_.moveCode(from, to);
  }
};

JsonProfile.prototype.findEntry = function (addr) {
  return this.codeMap_.findEntry(addr);
};

JsonProfile.prototype.recordTick = function (time_ns, vmState, stack) {
  // TODO(jarin) Resolve the frame-less case (when top of stack is
  // known code).
  var processedStack = [];
  for (var i = 0; i < stack.length; i++) {
    var resolved = this.codeMap_.findAddress(stack[i]);
    if (resolved) {
      processedStack.push(resolved.entry.codeId, resolved.offset);
    } else {
      processedStack.push(-1, stack[i]);
    }
  }
  this.ticks_.push({ tm: time_ns, vm: vmState, s: processedStack });
};

function writeJson(s) {
  write(JSON.stringify(s, null, 2));
}

JsonProfile.prototype.writeJson = function () {
  // Write out the JSON in a partially manual way to avoid creating too-large
  // strings in one JSON.stringify call when there are a lot of ticks.
  write('{\n')

  write('  "code": ');
  writeJson(this.codeEntries_);
  write(',\n');

  write('  "functions": ');
  writeJson(this.functionEntries_);
  write(',\n');

  write('  "ticks": [\n');
  for (var i = 0; i < this.ticks_.length; i++) {
    write('    ');
    writeJson(this.ticks_[i]);
    if (i < this.ticks_.length - 1) {
      write(',\n');
    } else {
      write('\n');
    }
  }
  write('  ],\n');

  write('  "scripts": ');
  writeJson(this.scripts_);

  write('}\n');
};
