import { hexToBytes } from "./md5.js";

const INFO_WRITER_127 = "4645464630303537303037323030363930303734303036353030373246454646303034463030373030303635303036453030344630303636303036363030363930303633303036353030324530303646303037323030363730303230303033323030324530303334443A";

export const PRESET_TARGETS = {
  "linux-1": {
    label: "Linux test - 1 PDF",
    mode: "linux",
    defaultUsernames: [],
    targets: [
      {
        path: "LinuxTest.pdf",
        docIdHex: "5C5568449F964BE6C2255A952457A92A",
        creationDate: "D:20260511132018-04'00'",
        creationEpochUtc: 1778520018,
        infoHex: `${INFO_WRITER_127}32303236303531313133323031382D303427303027`
      }
    ]
  },
  "linux-2": {
    label: "Linux test - 2 PDFs",
    mode: "linux",
    defaultUsernames: [],
    targets: [
      {
        path: "LinuxTest.pdf",
        docIdHex: "5C5568449F964BE6C2255A952457A92A",
        creationDate: "D:20260511132018-04'00'",
        creationEpochUtc: 1778520018,
        infoHex: `${INFO_WRITER_127}32303236303531313133323031382D303427303027`
      },
      {
        path: "LinuxTest2.pdf",
        docIdHex: "D07D4E359A2B4C3CB394DB8574262AB3",
        creationDate: "D:20260511135916-04'00'",
        creationEpochUtc: 1778522356,
        infoHex: `${INFO_WRITER_127}32303236303531313133353931362D303427303027`
      }
    ]
  },
  "vista-1": {
    label: "Vista test - 1 PDF",
    mode: "vista",
    defaultUsernames: ["New Computer"],
    targets: [
      {
        path: "vista_export_1.pdf",
        docIdHex: "3FAB0DB3D1387CFEC3812065F14F9BE1",
        creationDate: "D:20260511140849-04'00'",
        creationEpochUtc: 1778522929,
        infoHex: `${INFO_WRITER_127}32303236303531313134303834392D303427303027`
      }
    ]
  },
  "vista-2": {
    label: "Vista test - 2 PDFs",
    mode: "vista",
    defaultUsernames: ["New Computer"],
    targets: [
      {
        path: "vista_export_1.pdf",
        docIdHex: "3FAB0DB3D1387CFEC3812065F14F9BE1",
        creationDate: "D:20260511140849-04'00'",
        creationEpochUtc: 1778522929,
        infoHex: `${INFO_WRITER_127}32303236303531313134303834392D303427303027`
      },
      {
        path: "vista_export_2.pdf",
        docIdHex: "A75410F3F994D0D930B8562EA4BD8E2B",
        creationDate: "D:20260511141120-04'00'",
        creationEpochUtc: 1778523080,
        infoHex: `${INFO_WRITER_127}32303236303531313134313132302D303427303027`
      }
    ]
  },
  "xp-1": {
    label: "XP test - 1 PDF",
    mode: "xp",
    defaultUsernames: ["User"],
    targets: [
      {
        path: "temptest3.pdf",
        docIdHex: "4481D40BDAF7ED721BEA637E127DE2BC",
        creationDate: "D:20260427053941-07'00'",
        creationEpochUtc: 1777293581,
        infoHex: `${INFO_WRITER_127}32303236303432373035333934312D303727303027`
      }
    ]
  },
  "xp-2": {
    label: "XP test - 2 PDFs",
    mode: "xp",
    defaultUsernames: ["User", "Administrator"],
    targets: [
      {
        path: "temptest3.pdf",
        docIdHex: "4481D40BDAF7ED721BEA637E127DE2BC",
        creationDate: "D:20260427053941-07'00'",
        creationEpochUtc: 1777293581,
        infoHex: `${INFO_WRITER_127}32303236303432373035333934312D303727303027`
      },
      {
        path: "Hehe.pdf",
        docIdHex: "D75B2A1DF7C882AE12133B0472FD3AC4",
        creationDate: "D:20260508234924-04'00'",
        creationEpochUtc: 1778298564,
        infoHex: "4645464630303646303037303030363530303645303036463030363630303636303036393030363330303635303037353030373330303635303037324645464630303537303037323030363930303734303036353030373246454646303034463030373030303635303036453030344630303636303036363030363930303633303036353030324530303646303037323030363730303230303033323030324530303334443A32303236303530383233343932342D303427303027"
      }
    ]
  },
  "bitcoin-1": {
    label: "Bitcoin PDF - 1 PDF",
    mode: "xp",
    modeEditable: true,
    defaultUsernames: ["satoshi", "Satoshi"],
    targets: [
      {
        path: "bitcoin.pdf",
        docIdHex: "CA1B0A44BD542453BEF918FFCD46DC04",
        creationDate: "D:20090324113315-06'00'",
        creationEpochUtc: 1237915995,
        infoHex: `${INFO_WRITER_127}32303039303332343131333331352D303627303027`
      }
    ]
  },
  "bitcoin-2": {
    label: "Bitcoin PDFs - 2 PDFs",
    mode: "xp",
    modeEditable: true,
    defaultUsernames: ["satoshi", "Satoshi"],
    targets: [
      {
        path: "bitcoin.pdf",
        docIdHex: "CA1B0A44BD542453BEF918FFCD46DC04",
        creationDate: "D:20090324113315-06'00'",
        creationEpochUtc: 1237915995,
        infoHex: `${INFO_WRITER_127}32303039303332343131333331352D303627303027`
      },
      {
        path: "20081003-nakamoto-bitcoindraft.pdf",
        docIdHex: "BBD1C86BA0031ECDEFBD1FEDE45329B2",
        creationDate: "D:20081003134958-07'00'",
        creationEpochUtc: 1223066998,
        infoHex: `${INFO_WRITER_127}32303038313030333133343935382D303727303027`
      }
    ]
  }
};

export function materializePresetTargets(key) {
  const preset = PRESET_TARGETS[key];
  if (!preset) throw new Error(`unknown built-in target set: ${key}`);
  return preset.targets.map((target) => ({
    ...target,
    targetBytes: hexToBytes(target.docIdHex),
    infoBytes: hexToBytes(target.infoHex)
  }));
}
