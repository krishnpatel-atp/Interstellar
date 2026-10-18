/**
 * Health-record export. Builds an HL7 FHIR R4 "collection" Bundle with one
 * Observation per scan — the standard format EHR systems import. CelluSense is
 * *designed to integrate* with EHRs; this file is what would be sent.
 */
import { classifyRisk, round } from "./analysis.js";

const INTERPRETATION = {
  low: { code: "N", display: "Normal" },
  observation: { code: "A", display: "Abnormal" },
  high: { code: "H", display: "High" },
};

export function toFhirBundle(scans, { patient } = {}) {
  return {
    resourceType: "Bundle",
    type: "collection",
    timestamp: new Date().toISOString(),
    meta: { tag: [{ display: "CelluSense research prototype — estimated values" }] },
    entry: scans.map(s => {
      const zone = classifyRisk(s.ph);
      const obs = {
        resourceType: "Observation",
        id: String(s.id).replace(/[^A-Za-z0-9\-.]/g, "-").slice(0, 64),
        status: "final",
        category: [
          {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/observation-category",
                code: "exam",
                display: "Exam",
              },
            ],
          },
        ],
        code: {
          coding: [{ system: "urn:cellusense:codes", code: "wound-exudate-ph", display: "Wound exudate pH (estimated)" }],
          text: "Wound exudate pH — estimated by CelluSense colorimetric smart bandage",
        },
        subject: { display: s.patient || patient || "Unknown patient" },
        effectiveDateTime: new Date(s.ts).toISOString(),
        valueQuantity: { value: round(s.ph, 1), unit: "pH", system: "http://unitsofmeasure.org", code: "[pH]" },
        interpretation: [
          {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                ...INTERPRETATION[zone.id],
              },
            ],
            text: `${zone.zone}: ${zone.title}`,
          },
        ],
        method: { text: "Lighting-normalized R/G ratiometric colour analysis (printed reference ring)" },
        device: { display: "CelluSense smart bandage + mHealth scanner" },
        component: [
          {
            code: { text: "R/G colour index (R_center / G_center)" },
            valueQuantity: { value: round(s.ratio, 3), unit: "ratio", system: "http://unitsofmeasure.org", code: "1" },
          },
        ],
      };
      if (s.note) obs.note = [{ text: s.note }];
      return { fullUrl: `urn:uuid:cellusense-${obs.id}`, resource: obs };
    }),
  };
}
