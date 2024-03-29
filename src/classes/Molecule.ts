import { organicSubset } from "../data-vars";
import { IBond } from "../types/Bonds";
import { IGroupStrMap, IMatchAtom, IPositionData } from "../types/Group";
import { createGenerateSmilesStackItemObject, IAtomCount, ICountAtoms, IElementToIonMap, IGenerateSmilesStackItem, createRenderOptsObject, defaultRenderOptsObject, IRenderOptions } from "../types/SMILES";
import { IRec, IVec } from "../types/utils";
import { assembleEmpiricalFormula, assembleMolecularFormula, extractElement, extractInteger, getBondNumber, numArrWrap, numstr, rotateCoords, _regexNum } from "../utils";
import { AdvError } from "./Error";
import { Group } from "./Group";
import { Ring } from "./Rings";

export class Molecule {
  public groups: { [id: number]: Group };
  public rings: Ring[];

  constructor();
  constructor(groups: Group[]);
  constructor(groups: { [id: number]: Group });
  constructor(groups?: | Group[] | { [id: number]: Group }) {
    this.rings = [];
    if (groups === undefined) {
      this.groups = {};
    } else if (Array.isArray(groups)) {
      this.groups = groups.reduce((obj, group) => {
        obj[group.ID] = group;
        return obj;
      }, {});
    } else {
      this.groups = groups;
    }
  }

  /** Calculate Mr for a compound */
  public calculateMr() {
    if (Object.values(this.groups).length === 0) return 0;
    const stack: number[] = [+Object.keys(this.groups)[0]];
    const done = new Set<number>();
    let Mr = 0;
    while (stack.length !== 0) {
      const id = stack.pop(), group = this.groups[id];
      if (!done.has(id)) {
        done.add(id);
        Mr += group.calculateMr();
        group.bonds.forEach(bond => {
          stack.push(bond.dest);
        });
      }
    }
    return Mr;
  }

  /** Get bond object between two groups, or NULL */
  public getBond(id1: number, id2: number) {
    let bond = this.groups[id1].bonds.find(b => b.dest === id2);
    if (bond) return bond;
    bond = this.groups[id2].bonds.find(b => b.dest === id1);
    if (bond) return bond;
    return null;
  }

  /** Get all bonds to/from a group ID (.dest is group groupID is bonded to) */
  public getAllBonds(groupID: number) {
    const bonds: IBond[] = this.groups[groupID].bonds.map(bond => ({ ...bond }));
    for (const gid in this.groups) {
      if (+gid === groupID) continue;
      this.groups[gid].bonds.forEach(bond => {
        if (bond.dest === groupID) {
          const nbond = { ...bond };
          nbond.dest = +gid;
          bonds.push(nbond);
        }
      });
    }
    return bonds;
  }

  /** Sever bond between two groups */
  public severBond(id1: number, id2: number) {
    let i = this.groups[id1].bonds.findIndex(b => b.dest === id2);
    if (i === -1) {
      i = this.groups[id2].bonds.findIndex(b => b.dest === id1);
      if (i === -1) return false;
      this.groups[id2].bonds.splice(i, 1);
      return true;
    } else {
      this.groups[id1].bonds.splice(i, 1);
      return true;
    }
  }

  /** Get total bond count for a group */
  public getBondCount(groupID: number) {
    let count = 0;
    this.groups[groupID].bonds.forEach(bond => (count += getBondNumber(bond.bond)));
    for (let gid in this.groups) {
      if (+gid === groupID) continue;
      this.groups[gid].bonds.forEach(bond => bond.dest === groupID && (count += getBondNumber(bond.bond)));
    }
    return count;
  }

  /** Remove unbonded groups from molecule, starting from a given group. Return all discarded groups */
  public removeUnbondedGroups(startID: number) {
    const bondedGroups = new Set<number>(); // Set of group IDs which are bonded
    bondedGroups.add(startID);
    const stack: number[] = [startID]; // Stack of groups to explore
    const doneGroups = new Set<number>(); // Set of groups which have been explored

    while (stack.length !== 0) {
      const gid = stack.pop();
      if (!doneGroups.has(gid)) {
        doneGroups.add(gid);
        const bonds = this.getAllBonds(gid);
        for (let i = bonds.length - 1; i >= 0; --i) {
          if (!doneGroups.has(bonds[i].dest)) {
            stack.push(bonds[i].dest);
            bondedGroups.add(bonds[i].dest); // This group is bonded to startID
          }
        }
      }
    }

    // Remove all groups which are not bonded
    const discarded: { [gid: number]: Group } = {};
    for (let gid in this.groups) {
      if (!bondedGroups.has(+gid)) {
        discarded[gid] = this.groups[gid];
        delete this.groups[gid]; // Remove
      }
    }
    return discarded;
  }

  /** Add implicit hydrogens to atoms e.g. C -> C([H])([H])[H]. Note, these hydrogens are marked as implicit and will not be in generated SMILES */
  public addImplicitHydrogens() {
    for (const gid in this.groups) {
      const group = this.groups[gid];
      if (!group.isRadical && group.inOrganicSubset()) {
        const bonds = this.getBondCount(group.ID);
        if (group.charge === 0) {
          // Find target bonds
          let targetBonds: number = NaN, el = Array.from(group.elements.keys())[0];
          for (let n of organicSubset[el]) {
            if (n >= bonds) {
              targetBonds = n
              break;
            }
          }
          // Add hydrogens (if got targetBonds)
          if (!isNaN(targetBonds)) {
            let hCount = targetBonds - bonds;
            for (let h = 0; h < hCount; h++) {
              let H = new Group({ chainDepth: group.chainDepth + 1 });
              H.addElement("H");
              H.isImplicit = true;
              group.addBond('-', H);
              this.groups[H.ID] = H;
            }
          }
        }
      }
    }
  }

  /**
   * Check each atom - has it too many/few bonds?
   * Return `true` if valid, else returns information object
  */
  public checkBondCounts(): true | { group: Group, element: string, error: AdvError } {
    for (const gid in this.groups) {
      const group = this.groups[gid], bonds = this.getBondCount(group.ID);
      if (group.charge === 0 && !group.isRadical && group.inOrganicSubset()) {
        let el = Array.from(group.elements.keys())[0] as string;
        if (!isNaN(organicSubset[el][0]) && !organicSubset[el].some((n: number) => n === bonds)) {
          const error = new AdvError(`Bond Error: invalid bond count for organic atom '${el}': ${bonds}. Expected ${organicSubset[el].join(' or ')}.`, el).setColumnNumber(group.smilesStringPosition);
          return { group, element: el, error };
        }
      }
    }
    return true;
  }

  /** Return array of matching recIDs if match. */
  // TODO Multiple of same chain from single atom, not only in top-most atom? (e.g. OCO) 
  public matchMolecule(thing: IMatchAtom, matchMany = true): IGroupStrMap[] {
    const matches: IGroupStrMap[] = [];
    for (const gid in this.groups) {
      const rec: IGroupStrMap = {};
      let match = this.groups[gid].matchAtoms(thing, this, rec, true);
      if (match) {
        matches.push(rec);
        if (!matchMany) break;
      }
    }
    return matches;
  }

  /**
   * Test for benzene, with one substitued carbon.
   * 
   * Default, substitutuent is just Hydrogen.
   * 
   * Returned map: IDs 0-5 are used for ring carbons. map[0] is carbon that substituent is bonded to.
   */
  public matchBenzene(substitute?: IMatchAtom, matchMany = true): IGroupStrMap[] {
    if (substitute === undefined) substitute = { atom: "H" };
    const matches: IGroupStrMap[] = [];
    for (let ring of this.rings) {
      if (!ring.isAromatic || ring.members.length !== 6) continue;
      let cs = 0, hs = 0, si = -1, sr: IGroupStrMap = {}; // Carbons, index of substituent
      for (let i = 0; i < ring.members.length; ++i) {
        if (this.groups[ring.members[i]].isElement("C")) {
          cs++;
          let to = this.getAllBonds(ring.members[i]).find(b => ring.members.indexOf(b.dest) === -1);
          if (!to) { }
          else if (si === -1 && this.groups[to.dest].matchAtoms(substitute, this, sr, true)) si = i;
          else if (this.groups[to.dest].isElement("H")) hs++;
        }
      }
      if (cs === 6 && hs === 5 && si !== -1) {
        const map: IGroupStrMap = {};
        for (let j = 0, k = 0, met = false; j < ring.members.length;) {
          if (k in map) { }
          else if (met) {
            map[k] = this.groups[ring.members[j]];
            k++;
            if (k >= ring.members.length) break;
          } else if (j === si) {
            met = true;
            continue;
          }
          j = (j + 1) % ring.members.length;
        }
        for (let x in sr) map[x] = sr[x];
        matches.push(map);
        if (!matchMany) break;
      }
    }
    return matches;
  }

  /**
   * Scan for ring structures with the given members. ringMembers[0] is bonded to ringMembers[-1]
   * 
   * - For property `ringMembers[k].bondedTo`, ring members are **excluded**
   * - For property `ringMembers[k].bond`, this indicates how member `k-1` is bonded to member `k`
   * 
   * On record, add property `_ringID`
   */
  public matchRing(ringMembers: IMatchAtom[], aromatic: boolean, matchMany = true) {
    const matches: IGroupStrMap[] = [];
    for (let ring of this.rings) {
      if (ring.members.length === ringMembers.length && ring.isAromatic === aromatic) {
        let rec: IGroupStrMap, match: boolean;
        for (let i = 0; i < ringMembers.length; ++i) {
          match = true;
          rec = {};
          const indexes = numArrWrap(ring.members.length, i);
          for (let j = 0; match && j < indexes.length; j++) {
            if (ringMembers[indexes[j]].bond !== undefined) {
              let bond = this.getBond(ring.members[indexes[j === 0 ? indexes.length - 1 : j - 1]], ring.members[indexes[j]]);
              if (!bond || bond.bond !== ringMembers[indexes[j]].bond) match = false;
            }
            if (match) match = this.groups[ring.members[indexes[j]]].matchAtoms(ringMembers[j], this, rec, true);
          }
          if (match) break;
        }
        if (match) {
          rec._ringID = ring.ID;
          matches.push(rec);
          if (!matchMany) break;
        }
      }
    }
    return matches;
  }

  /** Make ring aromatic */
  public aromaticifyRing(ringId: number, lowercase = true) {
    let ring = this.rings.find(ring => ring.ID === ringId);
    ring.isAromatic = true;
    for (let i = 0; i < ring.members.length; ++i) {
      let bond = this.getBond(ring.members[i], ring.members[(i + 1) % ring.members.length]);
      bond.bond = ":";
      if (lowercase) this.groups[ring.members[i]].isLowercase = true;
      if (this.groups[ring.members[i]].bonds.length >= 4) {
        let j = this.groups[ring.members[i]].bonds.findIndex(bond => this.groups[bond.dest].isElement("H"));
        if (j !== -1) this.groups[ring.members[i]].bonds.splice(j, 1);
      }
    }
  }

  /** Reduce aromatic ring */
  public deAromaticifyRing(ringId: number, implicitHs = true) {
    let ring = this.rings.find(ring => ring.ID === ringId);
    ring.isAromatic = false;
    for (let i = 0; i < ring.members.length; ++i) {
      let bond = this.getBond(ring.members[i], ring.members[(i + 1) % ring.members.length]);
      bond.bond = "-";
      this.groups[ring.members[i]].isLowercase = false;
      let H = new Group(["H"]);
      H.isImplicit = implicitHs;
      this.groups[H.ID] = H;
      this.groups[ring.members[i]].addBond("-", H);
    }
  }

  /**
   * Count each atom in parsed data
   * Order the AtomCount object via the Hill system
   * - Hill system => carbons, hydrogens, then other elements in alphabetical order
   * - Ignore charge => ignore charge on atoms?
   */
  public countAtoms(opts: ICountAtoms = {}): IAtomCount[] {
    opts.splitGroups ??= false;
    opts.hillSystemOrder ??= true;
    opts.ignoreCharge ??= false;

    let atoms: IAtomCount[] = [], elementsPos: string[] = [];
    for (const id in this.groups) {
      if (this.groups.hasOwnProperty(id)) {
        const group = this.groups[id], groupCharge = opts.ignoreCharge ? 0 : group.charge;
        if (opts.splitGroups) {
          group.elements.forEach((count, element) => {
            let chargeStr = element + '{' + groupCharge + '}', i = elementsPos.indexOf(chargeStr);
            if (atoms[element] === undefined) {
              atoms.push({ atom: element, charge: NaN, count: 0 }); // If splitting groups up, cannot associate charge
              elementsPos.push(chargeStr);
              i = elementsPos.length - 1;
            }
            atoms[i].count += count;
          });
        } else {
          let str = group.getElementString(false, true), chargeStr = str + '{' + groupCharge + '}', i = elementsPos.indexOf(chargeStr);
          if (atoms[i] === undefined) {
            atoms.push({ atom: str, charge: groupCharge, count: 0 });
            elementsPos.push(chargeStr);
            i = elementsPos.length - 1;
          }
          atoms[i].count++;
        }
      }
    }
    if (opts.splitGroups) {
      // Deconstruct numbered atoms e.g. "H2": 1 --> "H": 2
      let newAtoms: IAtomCount[] = [], elementsPos: string[] = [];
      for (let i = 0; i < atoms.length; i++) {
        const group = atoms[i];
        if (_regexNum.test(group.atom)) {
          let atom = extractElement(group.atom), count = extractInteger(group.atom.substr(atom.length)), str = atom + "{" + group.charge + "}", i = elementsPos.indexOf(str);
          if (i === -1) {
            newAtoms.push({ atom, count, charge: NaN });
            elementsPos.push(str);
          } else {
            newAtoms[i].count += count;
          }
        } else {
          let str = group.atom + "{" + group.charge + "}", i = elementsPos.indexOf(str);
          if (i === -1) {
            newAtoms.push(group);
            elementsPos.push(str);
          } else {
            newAtoms[i].count += group.count;
          }
        }
      }
      atoms = newAtoms;
    }
    if (opts.hillSystemOrder) {
      let newAtoms: IAtomCount[] = [], elementPos: string[] = [];
      // Carbons come first
      let carbons: IAtomCount[] = [];
      for (let i = atoms.length - 1; i >= 0; i--) {
        if (atoms[i].atom === 'C') {
          carbons.push(atoms[i]);
          atoms.splice(i, 1);
        }
      }
      carbons.sort((a, b) => a.charge - b.charge);
      newAtoms.push(...carbons);
      // Hydrogens come second
      let hydrogens: IAtomCount[] = [];
      for (let i = atoms.length - 1; i >= 0; i--) {
        if (atoms[i].atom === 'H') {
          hydrogens.push(atoms[i]);
          atoms.splice(i, 1);
        }
      }
      hydrogens.sort((a, b) => a.charge - b.charge);
      newAtoms.push(...hydrogens);
      // Sort rest by alphabetical order
      let elements: IElementToIonMap = {}, elementKeys: string[] = [];
      // Extract element ions
      for (let group of atoms) {
        if (elements[group.atom] === undefined) {
          elements[group.atom] = [];
          elementKeys.push(group.atom);
        }
        elements[group.atom].push(group);
      }
      // Order ions by charge
      for (let element in elements) {
        if (elements.hasOwnProperty(element)) {
          elements[element].sort((a, b) => a.charge - b.charge);
        }
      }
      // Order elements alphabeticalls
      elementKeys.sort();
      elementKeys.forEach(e => {
        elements[e].forEach(ion => {
          newAtoms.push(ion);
        });
      });
      return newAtoms;
    }
    return atoms;
  }

  /** Count number of matching elements given group is bonded to */
  public countBondedElements(groupID: number, elements: string | string[], includeImplicit = false) {
    if (typeof elements === "string") elements = [elements];
    return this.getAllBonds(groupID).filter(bond => (this.groups[bond.dest].isImplicit ? includeImplicit : true) && this.groups[bond.dest].isElement(...elements)).length;
  }

  /**
   * Generate molecular formula
   * e.g. "C2H4O2"
   * @param detailed - If true, will keep [NH4+] and not split it up, keep charges etc...
   * @param html - Return formula as HTML?
   * @param useHillSystem - Use hill system to order formula in conventional way?
   */
  public generateMolecularFormula(opts: ICountAtoms = {}, html = false): string {
    opts.ignoreCharge = true;
    let count = this.countAtoms(opts);
    return assembleMolecularFormula(count, html);
  }
  /**
   * Generate empirical formula
   * e.g. "C2H4O2" -> "CH2O"
   * @param html - Return formula as HTML?
   * @param useHillSystem - Use hill system to order formula in conventional way?
   */
  public generateEmpiricalFormula(html = false, useHillSystem = true): string {
    let count = this.countAtoms({ splitGroups: true, hillSystemOrder: useHillSystem });
    return assembleEmpiricalFormula(count, html);
  }
  /**
   * Generate condensed formula
   * e.g. "C2H4O2" -> CH3COOH
   * - collapseSucecssiveGroups => condense groups e.g. "CH3CH2CH2CH3" -> "CH3(CH2)2CH3"
   * @param html - Return formula as HTML?
   */
  public generateCondensedFormula(html = false, collapseSucecssiveGroups = true): string {
    if (Object.values(this.groups).length === 0) return "";

    let elements: Map<string, number>[] = []; // Array of elements for each group
    const stack: number[] = []; // Stack of IDs to this._group (or NaN if done)
    const doneGroups = new Set<number>(); // Set of group IDs which have been done
    stack.push(+Object.keys(this.groups)[0]);

    while (stack.length !== 0) {
      const i = stack.length - 1, group = this.groups[stack[i]];
      if (isNaN(stack[i]) || doneGroups.has(group.ID)) {
        stack.splice(i, 1);
      } else {
        let groupElements = new Map<string, number>();
        groupElements.set(group.toStringFancy(html, false), 1);
        const bonds = this.getAllBonds(group.ID);
        for (let j = bonds.length - 1; j >= 0; j--) {
          const bond = bonds[j];
          if (!doneGroups.has(bond.dest) && this.groups[bond.dest].bonds.length === 0) {
            let el = this.groups[bond.dest].toStringFancy(html, false);
            groupElements.set(el, (groupElements.get(el) ?? 0) + 1);
            doneGroups.add(bond.dest);
          }
          stack.push(bond.dest);
        }
        elements.push(groupElements);
        stack[i] = NaN;
        doneGroups.add(group.ID);
      }
    }
    let string = '', lastSegment: string, segCount = 0;
    elements.forEach((map, ei) => {
      let j = 0, segStr = '';
      map.forEach((count, el) => {
        let str = count === 1 ? el : el + (html ? "<sub>" + numstr(count) + "</sub>" : count.toString());
        if (j > 0 && j < map.size - 1 && count > 1) str = "(" + str + ")";
        j++;
        segStr += str;
      });
      if (collapseSucecssiveGroups) {
        if (lastSegment === undefined) {
          lastSegment = segStr;
          segCount = 1;
        } else if (segStr === lastSegment) {
          segCount++;
        } else {
          string += segCount === 1 ? lastSegment : "(" + lastSegment + ")" + (html ? "<sub>" + numstr(segCount) + "</sub>" : segCount.toString());
          lastSegment = segStr;
          segCount = 1;
        }
      } else {
        string += segStr;
      }
    });
    if (collapseSucecssiveGroups && segCount !== 0) {
      string += segCount === 1 ? lastSegment : "(" + lastSegment + ")" + (html ? "<sub>" + numstr(segCount) + "</sub>" : segCount.toString());
    }
    return string;
  }

  /** Generate SMILES string from parsed data.
   * @param showImplicits - Render implicit groups? (if .isImplicit === true)
  */
  public generateSMILES(showImplicits = false): string {
    if (Object.keys(this.groups).length === 0) return "";

    /** Assemble and return SMILES string from a StackItem */
    const assembleSMILES = (item: IGenerateSmilesStackItem): string => {
      item.smilesChildren = item.smilesChildren.filter(x => x.length > 0);
      let lastChild = item.smilesChildren.pop();
      return item.smiles + item.smilesChildren.map(x => `(${x})`).join('') + (lastChild || '');
    };

    let smiles = '';
    const stack: IGenerateSmilesStackItem[] = [];
    const doneGroups = new Set<number>();
    stack.push(createGenerateSmilesStackItemObject(+Object.keys(this.groups)[0])); // Add root group

    while (stack.length !== 0) {
      const i = stack.length - 1;
      if (stack[i].handled) {
        // Handled; remove from array
        if (stack[i].parent !== undefined) {
          let j = stack[i].parent;
          stack[j].smilesChildren.push(assembleSMILES(stack[i]));
        } else {
          smiles = assembleSMILES(stack[i]) + smiles;
        }
        stack.splice(i, 1);
      } else {
        const group = this.groups[stack[i].group];
        if (doneGroups.has(group.ID)) {
          stack[i].handled = true;
        } else {
          // Shall we render this?
          const render = !group.isImplicit || (group.isImplicit && showImplicits);
          if (render) {
            let bond = stack[i].bond && stack[i].bond !== '-' ? (stack[i].bond === ":" && this.groups[stack[i].group].isLowercase ? "" : stack[i].bond) : ''; // Get bond between molecules. If aromatic bond and lowercase, ignore
            stack[i].smiles += bond;
            stack[i].smiles += group.toString();
            if (group.ringDigits.length !== 0) stack[i].smiles += group.ringDigits.map(n => '%' + n).join('');
          }
          stack[i].handled = true;

          // Bonds (add in reverse as topmost is processed first)
          const bonds = this.getAllBonds(group.ID);
          for (let j = bonds.length - 1; j >= 0; j--) {
            const obj = bonds[j];
            if (!doneGroups.has(obj.dest)) {
              stack.push(createGenerateSmilesStackItemObject(obj.dest, i, obj.bond));
            }
          }

          doneGroups.add(group.ID);
        }
      }
    }
    return smiles;
  }

  /** Find all paths from one group to another. Return array of bond position IDs. Only visit groups whose IDs are in availableGroups */
  public pathfind(startID: number, endID: number, availableGroups?: number[]) {
    const paths: number[][] = [];
    const current: number[] = []; // Current path (bond indexes from startID)
    const currGroups: number[] = [] // Stack of groups so we can backtrack
    const explored = new Map<number, number>(); // Maps group ID to the bond it should start iterating at
    const allBonds = new Map<number, IBond[]>(); // Map all group IDs to (full) bond array
    for (let gid in this.groups) {
      explored.set(+gid, 0);
      allBonds.set(+gid, this.getAllBonds(+gid));
    }

    currGroups.push(startID);

    while (currGroups.length > 0) {
      const gid = currGroups[currGroups.length - 1];
      if (gid === endID) { // At end?
        paths.push([...current]);
        current.pop();
        currGroups.pop();
      } else {
        // Explore each bond
        const bonds = allBonds.get(gid), bi = explored.get(gid);
        if (bi < bonds.length) {
          if (bonds[bi].dest === currGroups[currGroups.length - 2] || availableGroups?.indexOf(bonds[bi].dest) === -1) { // Backtrack or out of bounds?
            // Pass
          } else {
            current.push(bi);
            currGroups.push(bonds[bi].dest);
          }
          explored.set(gid, bi + 1); // Iterate to next bond
        } else { // Fully explored from this group
          currGroups.pop();
          current.pop();
        }
      }
    }

    return paths;
  }

  /** From starting group ID, given an array of bond indexes to follow (all bonds from this.getAllBonds) return array of group IDs */
  public traceBondPath(startID: number, path: number[]) {
    return path.reduce((p, c, i) => p.push(this.getAllBonds(p[i])[c].dest) && p, [startID]);
  }

  /** Return position vectors of each Group around (0,0) */
  public getPositionData(re?: IRenderOptions): IPositionData {
    if (Object.keys(this.groups).length === 0) return { groups: {}, rings: new Map(), angles: new Map(), dim: { x: 0, y: 0 } };
    if (re === undefined) re = defaultRenderOptsObject;

    const collision = (rec: IRec) => Object.values(posData).find(rec2 => rec.x - rec.w / 2 - re.atomOverlapPadding <= rec2.x + rec2.w / 2 + re.atomOverlapPadding && rec.x + rec.w / 2 + re.atomOverlapPadding >= rec2.x - rec2.w / 2 - re.atomOverlapPadding && rec.y - rec.h / 2 - re.atomOverlapPadding <= rec2.y + rec2.h / 2 + re.atomOverlapPadding && rec.y + rec.h / 2 + re.atomOverlapPadding >= rec2.y - rec2.h / 2 - re.atomOverlapPadding) ?? false;
    const posData: { [gid: number]: IRec } = {};
    const processStack: { id: number, fromId?: number, fromθ: number }[] = []; // Stack of group IDs to process
    const doneGroups = new Set<number>();
    const positionedInRing = new Set<number>(); // Set of all groups which have been sorted into a ring structure
    const ringMember = new Set<number>(); // Set of all group IDs which is a member of a ring
    Object.values(this.rings).forEach(ring => ring.members.forEach(mid => ringMember.add(mid)));
    const rings = new Map<number, { minX: number, maxX: number, minY: number, maxY: number }>();
    const angles = new Map<number, [number, number, boolean]>(); // Group IDs to angle [start, end, exclusive]
    const skeletalAngleMul = new Map<number, number>();
    let iters = 0;

    // For each group, populate text width/height
    for (let id in this.groups) {
      angles.set(+id, [0, 2 * Math.PI, false]);
      let { width: w, height: h } = re.skeletal && this.groups[id].isElement("C") ? { width: 0, height: 0 } : this.groups[id].getRenderAsTextDimensions(re, re.renderImplicit && re.collapseH ? this.getAllBonds(+id).filter(bond => this.groups[bond.dest].isImplicit && this.groups[bond.dest].isElement("H")).length : 0);
      posData[id] = { x: NaN, y: NaN, w, h };
    }

    // Start with forst group
    let gid = +Object.keys(this.groups)[0];
    processStack.push({ id: gid, fromθ: 0 });
    posData[gid].x = 0;
    posData[gid].y = 0;
    skeletalAngleMul.set(gid, 1);

    while (processStack.length !== 0) {
      const { id, fromId, fromθ } = processStack.pop();
      if (!doneGroups.has(id)) {
        const rec = posData[id]; // Current position vector

        // In ring?
        const ring = this.rings.find(ring => ring.members.some(mid => mid === id));
        if (ring) {
          if (!rings.has(ring.ID)) {
            let interior = 2 * Math.PI / ring.members.length; // Interior angle
            if ((fromθ < 1.5 * Math.PI && fromθ > 0.5 * Math.PI) || (fromθ > -0.5 * Math.PI && fromθ < -1.5 * Math.PI)) interior -= Math.PI;
            const rot = Math.PI / 2 - interior / 2;
            const ext = Math.PI - 2 * rot;
            let angle = angles.get(id)[0] + fromθ + rot;
            let x = rec.x, y = rec.y, minX = x, maxX = x, minY = y, maxY = y;
            const bondLength = Math.max(...ring.members.map((m, i) => re.bondLength + (posData[m].w + posData[ring.members[(i + 1) % ring.members.length]].w) / 2.5));
            for (let k = 0; k < ring.members.length; k++) {
              positionedInRing.add(ring.members[k]);
              const rec = posData[ring.members[k]];
              let [dx, dy] = rotateCoords(bondLength, angle);
              rec.x = x;
              rec.y = y;
              if (x > maxX) maxX = x;
              if (x < minX) minX = x;
              if (y > maxY) maxY = y;
              if (y < minY) minY = y;
              x += dx;
              y += dy;
              angles.set(ring.members[k], re.ringRestrictAngleSmall ? [angle + Math.PI, angle + ext, true] : [angle, angle + 2 * (Math.PI - ext), true]);
              angle -= ext;
            }
            rings.set(ring.ID, { minX, maxX, minY, maxY });
          }
        }

        // Get bonds
        let bondsTE = this.getAllBonds(id); // Bonds to explore
        if (!re.renderImplicit || (re.skeletal && this.groups[id].isElement("C"))) bondsTE = bondsTE.filter(bond => !this.groups[bond.dest].isImplicit);
        else if (re.collapseH) bondsTE = bondsTE.filter(bond => !(this.groups[bond.dest].isImplicit && this.groups[bond.dest].isElement("H")));
        let bondsTR = bondsTE.filter(bond => !positionedInRing.has(bond.dest)); // Bonds to render

        let [θu, θv, θexcl] = angles.get(id); // Start/end angle
        const sθ = re.skeletal && !ringMember.has(id) && ((skeletalAngleMul.get(id) * re.skeletalAngle) / fromθ === -1 || bondsTE.some(bond => this.groups[bond.dest].isElement("C") && !ringMember.has(bond.dest))) ? skeletalAngleMul.get(id) * re.skeletalAngle : 0; // Skeletal angle adjustment
        let df = iters === 0 || bondsTR.length === 1 ? bondsTR.length : bondsTR.length - 1;
        if (θexcl) df++;
        let θi = (θv - θu) / df; // angle increment
        for (let i = 0, θ = θu + (θexcl ? θi : 0); i < bondsTE.length; i++) {
          let did = bondsTE[i].dest, sθc = (ringMember.has(did) && fromθ % Math.PI !== 0) ? 0 : sθ;
          if (!this.groups[id].isElement("C") && !this.groups[did].isElement("C")) sθc = fromθ - Math.PI * 0.5;
          let θc = θ + sθc; // Copy angle
          if (!doneGroups.has(did)) {
            // Avoid collisions
            if (!positionedInRing.has(did)) {
              let bondLength = re.bondLength + rec.w / 2 + posData[did].w / 2; // Account for overlap from text
              let num = 1, denom = 1; // For finding fraction of angle
              let x: number, y: number;
              while (true) {
                ([x, y] = rotateCoords(bondLength, θc));
                const rec1 = { x: rec.x + x, y: rec.y + y, w: posData[did].w, h: posData[did].h };
                if (collision(rec1)) {
                  θc += θi * (num / denom);
                  if (num >= denom) {
                    denom++;
                    num = 1;
                  } else {
                    num++;
                  }
                } else break;
              }
              posData[did].x = rec.x + x;
              posData[did].y = rec.y + y;
            }
            processStack.push({ id: did, fromId: id, fromθ: θc % (2 * Math.PI) });
            skeletalAngleMul.set(did, (sθc === 0 ? 1 : -1) * skeletalAngleMul.get(id)); // Alternate
            θ += θi; // Increase angle
          }
        }
        doneGroups.add(id);
        iters++;
      }
    }

    // Find max/min coordinates
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let id in posData) {
      if (posData[id].x - posData[id].w / 2 < minX) minX = posData[id].x - posData[id].w / 2;
      if (posData[id].x + posData[id].w / 2 > maxX) maxX = posData[id].x + posData[id].w / 2;
      if (posData[id].y - posData[id].h / 2 < minY) minY = posData[id].y - posData[id].h / 2;
      if (posData[id].y + posData[id].h / 2 > maxY) maxY = posData[id].y + posData[id].h / 2;
    }
    rings.forEach(obj => {
      if (obj.minX < minX) minX = obj.minX;
      if (obj.maxX > maxX) maxX = obj.maxX;
      if (obj.minY < minY) minY = obj.minY;
      if (obj.maxY > maxY) maxY = obj.maxY;
    });
    minX -= re.moleculePadding;
    maxX += re.moleculePadding;
    minY -= re.moleculePadding;
    maxY += re.moleculePadding;

    // Make sure no coordinate is negative!
    let dx = Math.abs(minX), dy = Math.abs(minY);
    for (let id in posData) {
      posData[id].x += dx;
      posData[id].y += dy;
    }
    rings.forEach(obj => {
      obj.minX += dx;
      obj.maxX += dx;
      obj.minY += dy;
      obj.maxY += dy;
    });

    return { groups: posData, rings, angles, dim: { x: maxX - minX, y: maxY - minY } };
  }

  /** Return image of rendered molecule. If arg is of type IPositionData, use this instead of generating a new one */
  public render(ctx: OffscreenCanvasRenderingContext2D, re?: IRenderOptions, pd?: IPositionData): ImageData {
    if (Object.values(this.groups).length === 0) return ctx.createImageData(1, 1); // "Empty" image

    const ringMember = new Set<number>(); // Set of all group IDs which is a member of a ring
    Object.values(this.rings).forEach(ring => ring.members.forEach(mid => ringMember.add(mid)));

    if (re === undefined) re = createRenderOptsObject();
    if (pd === undefined) pd = this.getPositionData(re);

    // Fill background
    ctx.fillStyle = re.bg;
    ctx.fillRect(0, 0, pd.dim.x, pd.dim.y);

    // Bonds
    ctx.strokeStyle = re.defaultAtomColor;
    ctx.lineWidth = re.bondWidth;
    ctx.lineCap = "round";
    const GSTART = 0.35, GSTOP = 0.65;
    const drawBondLine = (sid: number, eid: number, pos: -1 | 0 | 1, c1: string, c2: string) => {
      let start: IVec, end: IVec;
      start = { x: pd.groups[sid].x, y: pd.groups[sid].y };
      end = { x: pd.groups[eid].x, y: pd.groups[eid].y };
      const θ = Math.atan2(end.y - start.y, end.x - start.x); // Angle between initial line and bond
      const s = Math.sin(θ), c = Math.cos(θ);
      if (pos !== 0) {
        const SBL = re.skeletal ? re.bondLength * (1 - re.smallBondLengthFrac) / 2 : 0; // Length to subtract from each end
        if (pos === 1) {
          start = { x: start.x + re.bondGap * s + SBL * c, y: start.y - re.bondGap * c + SBL * s };
          end = { x: end.x + re.bondGap * s - SBL * c, y: end.y - re.bondGap * c - SBL * s };
        } else {
          start = { x: start.x - re.bondGap * s + SBL * c, y: start.y + re.bondGap * c + SBL * s };
          end = { x: end.x - re.bondGap * s - SBL * c, y: end.y + re.bondGap * c - SBL * s };
        }
      }
      let grad = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
      grad.addColorStop(GSTART, c1);
      grad.addColorStop(GSTOP, c2);
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    };
    for (const id in pd.groups) {
      if (pd.groups[id] && !isNaN(pd.groups[id].x) && !isNaN(pd.groups[id].y)) {
        const c1 = this.groups[id].getRenderColor(re);
        for (const bond of this.groups[id].bonds) {
          if (pd.groups[bond.dest] && !isNaN(pd.groups[bond.dest].x) && !isNaN(pd.groups[bond.dest].y)) {
            const c2 = this.groups[bond.dest].getRenderColor(re);
            let inRing = ringMember.has(+id) && ringMember.has(bond.dest);

            if (bond.bond === "-" || bond.bond === "#" || bond.bond === ":" || (re.skeletal && bond.bond === "=")) {
              drawBondLine(+id, bond.dest, 0, c1, c2);
            }
            // double bond: inRing ? inner : outer
            if ((bond.bond === "=" && !re.skeletal) || bond.bond === "#") drawBondLine(+id, bond.dest, inRing ? -1 : 1, c1, c2);
            if (bond.bond === "=" || bond.bond === "#") drawBondLine(+id, bond.dest, inRing ? 1 : -1, c1, c2);
          }
        }
      }
    }

    // Loop through rings
    pd.rings.forEach((obj, id) => {
      const ring = this.rings.find(r => r.ID === id);
      // Calculate inner bounds
      let dx = Math.max(...ring.members.map(mem => pd.groups[mem].w / 2));
      let dy = Math.max(...ring.members.map(mem => pd.groups[mem].h / 2));
      let minX = obj.minX + dx, maxX = obj.maxX - dx, minY = obj.minY + dy, maxY = obj.maxY - dy;
      const rx = (maxX - minX) / 2, ry = (maxY - minY) / 2, r = Math.min(rx, ry);
      // Aromatic?
      if (ring.isAromatic) {
        ctx.beginPath();
        ctx.lineWidth = re.bondWidth;
        ctx.strokeStyle = re.defaultAtomColor;
        ctx.arc(minX + rx, minY + ry, r - re.aromaticRingGap, 0, 2 * Math.PI);
        ctx.stroke();
      }
      if (re.debugRings) {
        // Bounding box: outer
        ctx.strokeStyle = "#00FF00";
        ctx.strokeRect(obj.minX, obj.minY, obj.maxX - obj.minX, obj.maxY - obj.minY);
        // Bounding box: inner
        ctx.strokeStyle = "#FF00FF";
        ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
        // Centre
        ctx.beginPath();
        ctx.fillStyle = "red";
        ctx.arc(minX + rx, minY + ry, 2, 0, 2 * Math.PI);
        ctx.fill();
        // ID
        ctx.fillStyle = "mediumblue";
        ctx.font = re.debugFont.toString();
        ctx.fillText(id.toString(), minX + rx, minY + ry);
      }
    });

    // Render groups
    for (const id in pd.groups) {
      let rec = pd.groups[id], group = this.groups[id], P = 4, extraHs = 0;
      if (re.renderImplicit && re.collapseH) extraHs = this.getAllBonds(group.ID).filter(bond => (this.groups[bond.dest].isImplicit ? re.renderImplicit : false) && this.groups[bond.dest].isElement("H")).length;
      ctx.fillStyle = re.bg;
      if (re.skeletal && group.isElement("C")) {
        // Pass
      } else {
        ctx.fillRect(rec.x - rec.w / 2 - P, rec.y - rec.h / 2 - P, rec.w + 2 * P, rec.h + 2 * P);
        group.renderAsText(ctx, { x: rec.x - rec.w / 2, y: rec.y + rec.h * 0.25 }, re, extraHs);
      }

      if (group.isRadical) {
        ctx.beginPath();
        ctx.fillStyle = group.getRenderColor();
        ctx.arc(rec.x, rec.y - rec.h / 2 + re.radicalRadius, re.radicalRadius, 0, 2 * Math.PI);
        ctx.fill();
      }

      if (re.debugGroups) {
        // Centre
        ctx.beginPath();
        ctx.fillStyle = "red";
        ctx.arc(rec.x, rec.y, 2, 0, 2 * Math.PI);
        ctx.fill();
        // ID
        ctx.fillStyle = "mediumblue";
        ctx.font = re.debugFont.toString();
        ctx.fillText(group.ID.toString(), rec.x + rec.w / 2, rec.y);
        // Bounding box with Overlap Padding
        ctx.strokeStyle = "#00FF00";
        ctx.strokeRect(rec.x - rec.w / 2 - re.atomOverlapPadding, rec.y - rec.h / 2 - re.atomOverlapPadding, rec.w + 2 * re.atomOverlapPadding, rec.h + 2 * re.atomOverlapPadding);
        // Bounding box
        ctx.strokeStyle = "#FF00FF";
        ctx.strokeRect(rec.x - rec.w / 2, rec.y - rec.h / 2, rec.w, rec.h);
      }
    }

    // Angles of rotation?
    if (re.debugShowAngles) {
      ctx.font = re.debugFont.toString();
      let L = re.bondLength * 0.3, LINES = re.debugAngleLines ?? 5;
      pd.angles.forEach(([u, v], id) => {
        if (this.groups[id].isImplicit) return;
        const { x, y } = pd.groups[id];
        ctx.beginPath();
        ctx.strokeStyle = "blue";
        let [rx, ry] = rotateCoords(L, u);
        ctx.moveTo(x, y);
        ctx.lineTo(x + rx, y + ry);
        ctx.stroke();
        ctx.strokeText(u.toFixed(1), x + rx, y + ry);
        ctx.beginPath();
        ctx.strokeStyle = "red";
        ([rx, ry] = rotateCoords(L, v));
        ctx.moveTo(x, y);
        ctx.lineTo(x + rx, y + ry);
        ctx.stroke();
        ctx.strokeText(v.toFixed(1), x + rx, y + ry);
        ctx.strokeStyle = "green";
        let ai = (v - u) / (LINES + 1);
        for (let i = 0, a = u; i < (LINES + 1); i++, a += ai) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ([rx, ry] = rotateCoords(L / 3, a));
          ctx.lineTo(x + rx, y + ry);
          ctx.stroke();
        }
      });
    }

    // Return bounding box
    return ctx.getImageData(0, 0, pd.dim.x, pd.dim.y);
  }
}