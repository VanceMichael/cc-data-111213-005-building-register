// Unit interpretation for IFC4.
//
// A measure is only meaningful together with three things: the declared
// measure type (and therefore its dimension), the unit recorded on the value
// itself, and the project's unit assignment.  This module keeps all three
// instead of flattening them into a display string, so a ledger row can
// explain how its final number was obtained.

import { refIds, scalarNumber, stringValue } from './step.js';

const SI_PREFIX = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3,
  HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3,
  MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};

const SI_PREFIX_SYMBOL = {
  EXA: 'E', PETA: 'P', TERA: 'T', GIGA: 'G', MEGA: 'M', KILO: 'k',
  HECTO: 'h', DECA: 'da', DECI: 'd', CENTI: 'c', MILLI: 'm',
  MICRO: 'µ', NANO: 'n', PICO: 'p', FEMTO: 'f', ATTO: 'a',
};

const SI_NAME_SYMBOL = {
  METRE: 'm', SQUARE_METRE: 'm²', CUBIC_METRE: 'm³', GRAM: 'g',
  SECOND: 's', KELVIN: 'K', DEGREE_CELSIUS: '°C', AMPERE: 'A',
  MOLE: 'mol', CANDELA: 'cd', RADIAN: 'rad', STERADIAN: 'sr',
  HERTZ: 'Hz', NEWTON: 'N', PASCAL: 'Pa', JOULE: 'J', WATT: 'W',
  COULOMB: 'C', VOLT: 'V', FARAD: 'F', OHM: 'Ω', SIEMENS: 'S',
  WEBER: 'Wb', TESLA: 'T', HENRY: 'H', LUMEN: 'lm', LUX: 'lx',
  BECQUEREL: 'Bq', GRAY: 'Gy', SIEVERT: 'Sv', KATAL: 'kat',
};

// Factor from the named SI unit to its coherent SI base.  Gram and Celsius
// are the two entries that are not simply 1.
const SI_NAME_FACTOR = { GRAM: 1e-3, DEGREE_CELSIUS: 1 };
const SI_NAME_OFFSET = { DEGREE_CELSIUS: 273.15 };
const SI_NAMES = new Set(Object.keys(SI_NAME_SYMBOL));

// The dimension of a declared measure type.  Ambiguous or schema-specific
// measures are intentionally absent: an unknown dimension is reported rather
// than guessed.
export const MEASURE_UNIT = {
  IFCABSORBEDDOSEMEASURE: 'ABSORBEDDOSEUNIT',
  IFCACCELERATIONMEASURE: 'ACCELERATIONUNIT',
  IFCAMOUNTOFSUBSTANCEMEASURE: 'AMOUNTOFSUBSTANCEUNIT',
  IFCAREA: 'AREAUNIT',
  IFCCOUNTMEASURE: null,
  IFCCURVATUREMEASURE: 'CURVATUREUNIT',
  IFCDOSEEQUIVALENTMEASURE: 'DOSE_EQUIVALENT_UNIT',
  IFCELECTRICCAPACITANCEMEASURE: 'ELECTRICCAPACITANCEUNIT',
  IFCELECTRICCHARGEMEASURE: 'ELECTRICCHARGEUNIT',
  IFCELECTRICCONDUCTANCEMEASURE: 'ELECTRICCONDUCTANCEUNIT',
  IFCELECTRICCURRENTMEASURE: 'ELECTRICCURRENTUNIT',
  IFCELECTRICRESISTANCEMEASURE: 'ELECTRICRESISTANCEUNIT',
  IFCELECTRICVOLTAGEMEASURE: 'ELECTRICVOLTAGEUNIT',
  IFCENERGYMEASURE: 'ENERGYUNIT',
  IFCFORCEMEASURE: 'FORCEUNIT',
  IFCFREQUENCYMEASURE: 'FREQUENCYUNIT',
  IFCHEATFLUXDENSITYMEASURE: 'HEATFLUXDENSITYUNIT',
  IFCHEATINGVALUEMEASURE: 'HEATINGVALUEUNIT',
  IFCINTEGERCOUNTRATE: null,
  IFCILLUMINANCE: 'ILLUMINANCEUNIT',
  IFCINTEGERCOUNTRATEMEASURE: 'INTEGERCOUNTRATEMEASURE',
  IFCIONCONCENTRATIONMEASURE: 'IONCONCENTRATIONUNIT',
  IFCISOTHERMALMOISTURECAPACITYMEASURE: 'ISOTHERMALMOISTURECAPACITYUNIT',
  IFCKINEMATICVISCOSITYMEASURE: 'KINEMATICVISCOSITYUNIT',
  IFCLENGTHMEASURE: 'LENGTHUNIT',
  IFCLINEARVELOCITYMEASURE: 'LINEARVELOCITYUNIT',
  IFCLUMINOUSFLUXMEASURE: 'LUMINOUSFLUXUNIT',
  IFCLUMINOUSINTENSITYMEASURE: 'LUMINOUSINTENSITYUNIT',
  IFCMAGNETICFLUXDENSITYMEASURE: 'MAGNETICFLUXDENSITYUNIT',
  IFCMAGNETICFLUXMEASURE: 'MAGNETICFLUXUNIT',
  IFCMASSDENSITYMEASURE: 'MASSDENSITYUNIT',
  IFCMASSFLOWRATEMEASURE: 'MASSFLOWRATEUNIT',
  IFCMASSMEASURE: 'MASSUNIT',
  IFCMASSPERLENGTHMEASURE: 'MASSPERLENGTHUNIT',
  IFCMODULUSOFCOMPRESSIONMEASURE: 'MODULUSOFCOMPRESSIONUNIT',
  IFCMODULUSOFELASTICITYMEASURE: 'MODULUSOFELASTICITYUNIT',
  IFCMODULUSOFRIGIDITYMEASURE: 'MODULUSOFRIGIDITYUNIT',
  IFCMOMENTOFINERTIAMEASURE: 'MOMENTOFINERTIAUNIT',
  IFCMONETARYMEASURE: 'MONETARYUNIT',
  IFCPLANEANGLEMEASURE: 'PLANEANGLEUNIT',
  IFCPOWERMEASURE: 'POWERUNIT',
  IFCPRESSUREMEASURE: 'PRESSUREUNIT',
  IFCRADIOACTIVITYMEASURE: 'RADIOACTIVITYUNIT',
  IFCRATIOMEASURE: 'RATIOUNIT',
  IFCSOUNDPOWERLEVELMEASURE: 'SOUNDPOWERLEVELUNIT',
  IFCSOUNDPOWERMEASURE: 'SOUNDPOWERUNIT',
  IFCSOUNDPRESSURELEVELMEASURE: 'SOUNDPRESSURELEVELUNIT',
  IFCSOUNDPRESSUREMEASURE: 'SOUNDPRESSUREUNIT',
  IFCSPECIFICHEATCAPACITYMEASURE: 'SPECIFICHEATCAPACITYUNIT',
  IFCTEMPERATUREGRADIENTMEASURE: 'TEMPERATUREGRADIENTUNIT',
  IFCTEMPERATURERATEMEASURE: 'TEMPERATURERATEMEASURE',
  IFCTHERMALADMITTANCEMEASURE: 'THERMALADMITTANCEUNIT',
  IFCTHERMALCONDUCTIVITYMEASURE: 'THERMALCONDUCTIVITYUNIT',
  IFCTHERMALEXPANSIONCOEFFICIENTMEASURE: 'THERMALEXPANSIONCOEFFICIENTUNIT',
  IFCTHERMALRESISTANCEMEASURE: 'THERMALRESISTANCEUNIT',
  IFCTHERMALTRANSMITTANCEMEASURE: 'THERMALTRANSMITTANCEUNIT',
  IFCTHERMODYNAMICTEMPERATUREMEASURE: 'THERMODYNAMICTEMPERATUREUNIT',
  IFCTIMEMEASURE: 'TIMEUNIT',
  IFCTORQUEMEASURE: 'TORQUEUNIT',
  IFCVELOCITYMEASURE: 'VELOCITYUNIT',
  IFCVOLUME: 'VOLUMEUNIT',
  IFCVOLUMEMEASURE: 'VOLUMEUNIT',
  IFCVOLUMETRICFLOWRATEMEASURE: 'VOLUMETRICFLOWRATEUNIT',
  IFCWARPINGCONSTANTMEASURE: 'WARPINGCONSTANTUNIT',
  IFCWARPINGMOMENTMEASURE: 'WARPINGMOMENTUNIT',
};

const SI_PREFIX_ENTRIES = new Set([...Object.keys(SI_PREFIX)]);

function prefixOf(value) {
  return value?.kind === 'enum' && SI_PREFIX_ENTRIES.has(value.value) ? value.value : null;
}

function enumName(value) {
  return value?.kind === 'enum' ? value.value : null;
}

function numberFrom(value) {
  const number = scalarNumber(value);
  if (number !== null) return number;
  if (value?.kind === 'number') return value.value;
  return null;
}

function superscript(exponent) {
  const digits = String(exponent);
  const map = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴',
    5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  return [...digits].map(char => map[char] ?? char).join('');
}

export function formatExponent(symbol, exponent) {
  const power = Number(exponent);
  if (power === 1) return symbol;
  return `${symbol}${superscript(power)}`;
}

function joinDerivedSymbol(positives, negatives) {
  const numerator = positives.length ? positives.join('·') : '1';
  if (!negatives.length) return numerator;
  const denominator = negatives.join('·');
  return negatives.length > 1 ? `${numerator}/(${denominator})` : `${numerator}/${denominator}`;
}

// Build the unit context for one model.  All unit entities are resolved once
// and memoized; unit conversion chains are walked with cycle detection.
export function buildUnitContext(model) {
  const { byId } = model;
  const units = new Map();
  const resolving = new Set();
  const issues = [];
  let projectStepId = null;
  let unitAssignmentStepId = null;
  const byUnitType = new Map();

  const addIssue = issue => {
    issues.push(issue);
    return issue;
  };

  function resolveUnit(stepId) {
    if (units.has(stepId)) return units.get(stepId);
    const entity = byId.get(stepId);
    if (!entity) {
      addIssue({
        code: 'missing-unit',
        message: `单位引用 #${stepId} 不存在`,
        stepId,
      });
      return null;
    }
    if (resolving.has(stepId)) {
      addIssue({
        code: 'unit-cycle',
        message: `单位 #${stepId} 的换算链出现循环`,
        stepIds: [...resolving, stepId],
      });
      return null;
    }
    resolving.add(stepId);
    let unit;
    try {
      unit = resolveUnitEntity(entity);
    } catch (error) {
      addIssue({ code: 'unit-unreadable', message: error.message, stepId });
      unit = null;
    } finally {
      resolving.delete(stepId);
    }
    if (unit) units.set(stepId, unit);
    return unit;
  }

  function resolveUnitEntity(entity) {
    const unitType = enumName(entity.values[1]);
    const common = {
      stepId: entity.id,
      ifcType: entity.type,
      unitType,
      name: null,
      prefix: null,
      symbol: null,
      factorToSi: null,
      offsetToSi: 0,
      components: [],
      conversion: null,
      issues: [],
    };
    if (entity.type === 'IFCSIUNIT') {
      const prefix = prefixOf(entity.values[2]);
      const name = enumName(entity.values[3]);
      const nameSymbol = SI_NAME_SYMBOL[name] || name || '?';
      const prefixFactor = prefix ? SI_PREFIX[prefix] : 1;
      const prefixSymbol = prefix ? SI_PREFIX_SYMBOL[prefix] : '';
      common.name = name;
      common.prefix = prefix;
      common.symbol = `${prefixSymbol}${nameSymbol}`;
      if (!name || !SI_NAMES.has(name)) {
        common.issues.push('未知 SI 单位名称');
        addIssue({ code: 'unknown-si-unit', stepId: entity.id, name });
        return common;
      }
      common.siSymbol = nameSymbol;
      common.siName = name;
      common.factorToSi = prefixFactor * (SI_NAME_FACTOR[name] ?? 1);
      common.offsetToSi = SI_NAME_OFFSET[name] ?? 0;
      common.explanation = [
        {
          step: 'si-unit',
          stepId: entity.id,
          text: `SI 单位 ${common.symbol}${prefix ? `（前缀 ${prefix}，倍数 ${prefixFactor}）` : ''}`,
        },
      ];
      return common;
    }
    if (entity.type === 'IFCCONVERSIONBASEDUNIT' ||
        entity.type === 'IFCCONVERSIONBASEDUNITWITHOFFSET') {
      const name = stringValue(entity.values[2]) ?? `#${entity.id}`;
      const measureWithUnitId = refIds(entity.values[3])[0];
      const factorEntity = measureWithUnitId ? byId.get(measureWithUnitId) : null;
      common.name = name;
      common.symbol = name;
      if (!factorEntity || factorEntity.type !== 'IFCMEASUREWITHUNIT') {
        common.issues.push('换算单位缺少 IfcMeasureWithUnit');
        addIssue({
          code: 'missing-conversion-factor',
          stepId: entity.id,
          message: `单位 ${name} 的换算系数 ${measureWithUnitId ? `#${measureWithUnitId}` : '缺失'}`,
          missingStepId: measureWithUnitId ?? null,
        });
        return common;
      }
      const valueComponent = factorEntity.values[0];
      const valueType = valueComponent?.kind === 'typed' ? valueComponent.valueType : null;
      const value = numberFrom(valueComponent);
      const baseUnitId = refIds(factorEntity.values[1])[0];
      const baseUnit = baseUnitId ? resolveUnit(baseUnitId) : null;
      if (value === null || !baseUnit || baseUnit.factorToSi === null) {
        common.issues.push('换算系数不完整');
        addIssue({
          code: 'incomplete-conversion-unit',
          stepId: entity.id,
          message: `单位 ${name} 无法换算到 SI`,
          stepIds: [entity.id, factorEntity.id, baseUnitId].filter(Boolean),
        });
        return common;
      }
      const offset = entity.type === 'IFCCONVERSIONBASEDUNITWITHOFFSET'
        ? (numberFrom(entity.values[4]) ?? 0)
        : 0;
      // IfcConversionBasedUnitWithOffset applies the offset before the
      // conversion factor: base = (value + offset) × factor.  The linear form
      // stored here is value × factor + (offset × factor), which is the same
      // transform expressed as a single slope and intercept.
      const directFactor = value * baseUnit.factorToSi;
      const directOffset = offset * directFactor;
      common.siSymbol = baseUnit.siSymbol;
      common.siName = baseUnit.siName ?? null;
      common.factorToSi = directFactor;
      common.offsetToSi = directOffset;
      common.conversion = {
        measureWithUnitStepId: factorEntity.id,
        valueComponent: { declaredType: valueType, value },
        unitComponent: { stepId: baseUnitId, unit: summarizeUnit(baseUnit) },
        offset,
        formula: offset
          ? `(${'{value}'} + ${offset}) × ${directFactor}`
          : `{value} × ${directFactor}`,
      };
      common.explanation = [
        {
          step: 'conversion-unit',
          stepId: entity.id,
          text: `换算单位 ${name} = ${value} × ${baseUnit.symbol}` +
            (offset ? `，偏移 ${offset}（先加偏移再乘系数）` : '') +
            `，1 ${name} = ${directFactor} ${baseUnit.siSymbol}`,
        },
        ...baseUnit.explanation,
      ];
      return common;
    }
    if (entity.type === 'IFCDERIVEDUNIT') {
      const components = refIds(entity.values[0]).map(componentId => {
        const element = byId.get(componentId);
        if (!element) {
          addIssue({
            code: 'missing-derived-unit-element',
            stepId: entity.id,
            missingStepId: componentId,
            message: `派生单位 #${entity.id} 的元素 #${componentId} 不存在`,
          });
          return null;
        }
        const unitId = refIds(element.values[0])[0];
        const exponent = numberFrom(element.values[1]) ?? 1;
        const unit = unitId ? resolveUnit(unitId) : null;
        if (!unit || unit.factorToSi === null) {
          addIssue({
            code: 'incomplete-derived-unit',
            stepId: entity.id,
            missingStepId: unitId,
            message: `派生单位 #${entity.id} 的元素 #${componentId} 无法解析`,
          });
          return null;
        }
        return { elementStepId: componentId, exponent, unit };
      });
      if (components.some(component => component === null)) {
        common.issues.push('派生单位元素不完整');
        return common;
      }
      const factor = components.reduce(
        (product, component) => product * component.unit.factorToSi ** component.exponent,
        1,
      );
      const positives = components
        .filter(component => component.exponent > 0)
        .map(component => formatExponent(component.unit.symbol, component.exponent));
      const negatives = components
        .filter(component => component.exponent < 0)
        .map(component => formatExponent(component.unit.symbol, -component.exponent));
      common.name = stringValue(entity.values[2]) ?? null;
      common.symbol = joinDerivedSymbol(positives, negatives);
      const siPositives = components
        .filter(component => component.exponent > 0)
        .map(component => formatExponent(component.unit.siSymbol, component.exponent));
      const siNegatives = components
        .filter(component => component.exponent < 0)
        .map(component => formatExponent(component.unit.siSymbol, -component.exponent));
      common.siSymbol = joinDerivedSymbol(siPositives, siNegatives);
      common.siName = common.siSymbol;
      common.factorToSi = factor;
      common.components = components.map(component => ({
        elementStepId: component.elementStepId,
        exponent: component.exponent,
        unit: summarizeUnit(component.unit),
      }));
      common.explanation = [
        {
          step: 'derived-unit',
          stepId: entity.id,
          text: `派生单位 ${common.symbol} = ${components
            .map(component => `${component.unit.symbol}^${component.exponent}`)
            .join(' × ')}，SI 基准 ${common.siSymbol}`,
        },
        ...components.flatMap(component => component.unit.explanation),
      ];
      return common;
    }
    if (entity.type === 'IFCCONTEXTDEPENDENTUNIT') {
      const name = stringValue(entity.values[2]) ?? `#${entity.id}`;
      common.name = name;
      common.symbol = name;
      common.issues.push('上下文相关单位没有 SI 换算');
      addIssue({
        code: 'context-dependent-unit',
        stepId: entity.id,
        message: `上下文相关单位 ${name} 无法换算到 SI`,
      });
      return common;
    }
    if (entity.type === 'IFCMONETARYUNIT') {
      const currency = stringValue(entity.values[0]) ?? enumName(entity.values[0]) ?? '?';
      common.name = currency;
      common.symbol = currency;
      common.siSymbol = currency;
      common.factorToSi = 1;
      common.unitType = common.unitType ?? 'MONETARYUNIT';
      common.explanation = [{ step: 'monetary-unit', stepId: entity.id, text: `货币单位 ${currency}` }];
      return common;
    }
    addIssue({
      code: 'unknown-unit-type',
      stepId: entity.id,
      message: `未识别的单位实体 ${entity.type}`,
    });
    return common;
  }

  const project = model.byType.get('IFCPROJECT')?.[0] ?? null;
  if (project) {
    projectStepId = project.id;
    unitAssignmentStepId = refIds(project.values[8])[0] ?? null;
    if (unitAssignmentStepId) {
      const assignment = byId.get(unitAssignmentStepId);
      if (assignment) {
        for (const unitId of refIds(assignment.values[0])) {
          const unit = resolveUnit(unitId);
          if (!unit) continue;
          if (unit.unitType && !byUnitType.has(unit.unitType)) byUnitType.set(unit.unitType, unit);
          else if (unit.unitType) {
            addIssue({
              code: 'duplicate-unit-type',
              stepId: unitAssignmentStepId,
              message: `单位类型 ${unit.unitType} 被分配了多次`,
              stepIds: [unitId, byUnitType.get(unit.unitType)?.stepId].filter(Boolean),
            });
          }
        }
      } else {
        addIssue({
          code: 'missing-unit-assignment',
          stepId: project.id,
          missingStepId: unitAssignmentStepId,
          message: `项目单位分配 #${unitAssignmentStepId} 不存在`,
        });
      }
    } else {
      addIssue({ code: 'missing-unit-assignment', stepId: project.id, message: '项目没有单位分配' });
    }
  }

  return {
    projectStepId,
    unitAssignmentStepId,
    units,
    byUnitType,
    issues,
    resolveUnit,
    unitForDimension(dimension) {
      if (!dimension) return null;
      return byUnitType.get(dimension) ?? null;
    },
    summary() {
      return {
        projectStepId,
        unitAssignmentStepId,
        assignments: Object.fromEntries(
          [...byUnitType.entries()].map(([type, unit]) => [type, summarizeUnit(unit)]),
        ),
        // Issues keep their STEP ids so a unit problem can be traced back to
        // the statement that caused it.
        issues: issues.map(issue => ({ ...issue })),
      };
    },
  };
}

export function summarizeUnit(unit) {
  if (!unit) return null;
  return {
    stepId: unit.stepId,
    ifcType: unit.ifcType,
    unitType: unit.unitType,
    symbol: unit.symbol,
    siSymbol: unit.siSymbol ?? null,
    factorToSi: unit.factorToSi,
    offsetToSi: unit.offsetToSi || 0,
    ...(unit.prefix ? { prefix: unit.prefix } : {}),
    ...(unit.components.length ? { components: unit.components } : {}),
    ...(unit.issues?.length ? { issues: unit.issues } : {}),
  };
}

// Explain a single measured value.  Returns the raw value, the unit that was
// actually used and why, the normalized SI value, and every step in the chain
// keyed by STEP id.
export function explainMeasure({
  declaredType,
  rawValue,
  explicitUnitId = null,
  unitContext,
  propertyStepId = null,
}) {
  const dimension = MEASURE_UNIT[declaredType] ?? null;
  const warnings = [];
  const chain = [{
    step: 'declared-type',
    valueType: declaredType,
    dimension,
    propertyStepId,
    text: dimension
      ? `${declaredType} 按 ${dimension} 解释`
      : `${declaredType} 没有登记量纲，保留原类型`,
  }];
  if (!(declaredType in MEASURE_UNIT)) {
    warnings.push({
      code: 'unknown-measure-dimension',
      message: `度量类型 ${declaredType} 未登记量纲`,
    });
  }
  const explicit = explicitUnitId ? unitContext.resolveUnit(explicitUnitId) : null;
  const projectDefault = explicitUnitId ? null : unitContext.unitForDimension(dimension);
  const chosen = explicit || projectDefault;
  let unitSource = null;
  if (explicit) {
    unitSource = 'property';
    chain.push({
      step: 'property-unit',
      stepId: explicit.stepId,
      unit: summarizeUnit(explicit),
      text: `属性自带单位 ${explicit.symbol}（#${explicit.stepId}），优先于项目默认单位`,
    });
  } else if (projectDefault) {
    unitSource = 'project';
    chain.push({
      step: 'project-unit',
      stepId: projectDefault.stepId,
      unitAssignmentStepId: unitContext.unitAssignmentStepId,
      unit: summarizeUnit(projectDefault),
      text: `属性未带单位，采用项目分配的单位 ${projectDefault.symbol}（#${projectDefault.stepId}）`,
    });
  } else if (dimension !== null || !(declaredType in MEASURE_UNIT)) {
    // Only report a missing unit when one is genuinely required: an unknown
    // measure type keeps its raw value, and a registered dimensionless type
    // needs no project unit.
    chain.push({
      step: 'missing-unit',
      explicitUnitId,
      dimension,
      text: explicitUnitId
        ? `属性自带的单位 #${explicitUnitId} 无法解析`
        : `项目没有为 ${dimension ?? declaredType} 分配单位`,
    });
    warnings.push({
      code: explicitUnitId ? 'unresolved-property-unit' : 'missing-project-unit',
      missingStepId: explicitUnitId ?? null,
      message: explicitUnitId
        ? `属性单位 #${explicitUnitId} 无法解析`
        : `缺少 ${dimension ?? declaredType} 的项目单位`,
    });
  }
  const result = {
    declaredType,
    dimension,
    rawValue,
    unitSource,
    unit: chosen ? summarizeUnit(chosen) : null,
    canonical: null,
    warnings,
    chain,
  };
  // A deliberately dimensionless measure (counts, ratios) is complete as
  // written; there is no unit to look up.
  if (dimension === null && declaredType in MEASURE_UNIT && rawValue !== null) {
    result.unitSource = 'none';
    result.canonical = {
      value: rawValue,
      symbol: null,
      unitSymbol: null,
      factorToSi: 1,
      offsetToSi: 0,
      formula: `${rawValue}（无量纲）`,
    };
    chain.push({
      step: 'dimensionless',
      text: `${declaredType} 无量纲，按原值记录`,
    });
  }
  if (chosen?.explanation?.length) {
    result.unitChain = chosen.explanation;
    chain.push(...chosen.explanation.map(entry => ({ ...entry, unitStepId: chosen.stepId })));
  }
  if (chosen && chosen.factorToSi !== null && rawValue !== null) {
    const normalized = rawValue * chosen.factorToSi + (chosen.offsetToSi || 0);
    // A unit with an offset (Celsius) is reported with the Kelvin base, since
    // the normalized number is an absolute temperature, not a relative one.
    const baseSymbol = chosen.siName === 'DEGREE_CELSIUS' ? 'K' : chosen.siSymbol;
    result.canonical = {
      value: normalized,
      symbol: baseSymbol,
      unitSymbol: chosen.symbol,
      factorToSi: chosen.factorToSi,
      offsetToSi: chosen.offsetToSi || 0,
      formula: `(${rawValue} × ${chosen.factorToSi})${chosen.offsetToSi ? ` + ${chosen.offsetToSi}` : ''} = ${normalized} ${baseSymbol}`,
    };
    chain.push({
      step: 'normalized',
      stepId: chosen.stepId,
      formula: result.canonical.formula,
      text: `${rawValue} ${chosen.symbol} 换算为 ${normalized} ${chosen.siSymbol}（SI 基准）`,
    });
  }
  return result;
}
