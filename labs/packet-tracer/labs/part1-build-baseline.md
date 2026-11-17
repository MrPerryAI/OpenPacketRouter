# Part 1: Build FTI-lite

**Goal:** Build a working model of a national air traffic network and prove that every Center can reach the radar and radio sites.
**Time:** About 45 minutes. To skip the build, open the pre-built `pkt/faa-ftl-baseline.pkt` (made with [`ptbuilder/`](../ptbuilder/README.md)) and go straight to step 5.

## The story

You are a network technician at the FTI Network Operations Center (NOC). Your network carries two kinds of traffic that air traffic controllers can't work without:

- **SURVEILLANCE (VLAN 100):** radar data from remote radar sites to controller displays.
- **VOICE (VLAN 200):** radio links from remote radio sites, so controllers can talk to pilots.

Both VLANs are **stretched across the whole country** over trunks, so every Center and every remote site is in the *same* broadcast domain for each VLAN. Keep that in mind.

## Steps

### 1. Place the devices
Use [docs/topology.md](../docs/topology.md). Place and **rename** (Config tab → Display Name):

- 1 × **3560-24PS** → `NOC-SW`
- 5 × **2960-24TT** → `ZFW-SW`, `ZME-SW`, `ZAB-SW`, `ELD-OLD`, `AMA-SW`
- 7 × **PC** → `NOC-MON`, `ZFW-RADAR`, `ZFW-VOICE`, `ZME-RADAR`, `ZME-VOICE`, `ZAB-RADAR`, `ZAB-VOICE`
- 2 × **Server** → `ELD-RADIO`, `AMA-RADAR`

Tip: arrange them roughly like a US map, with Albuquerque on the left, Fort Worth in the middle, and Memphis on the right. Use the Note tool to label regions.

### 2. Cable it
Follow cabling table rows **1 to 13**. Switch-to-switch links use **Copper Cross-Over**. Everything else uses **Copper Straight-Through**.

### 3. Configure the switches
For each switch, open **CLI**, press Enter, and paste the matching file from [`configs/1-baseline/`](../configs/1-baseline/):

| Device | File |
|---|---|
| NOC-SW | `NOC-SW.txt` |
| ZFW-SW | `ZFW-SW.txt` |
| ZME-SW | `ZME-SW.txt` |
| ZAB-SW | `ZAB-SW.txt` |
| ELD-OLD | `ELD-OLD.txt` |
| AMA-SW | `AMA-SW.txt` |

**Read before you paste.** Two of these files have a comment flagged **LATENT CONDITION** or **template**. Write down which devices they are on the worksheet.

### 4. Configure the hosts
Desktop → IP Configuration. Use the **IP plan** table in topology.md. The RADAR PCs and NOC-MON don't need a gateway. The VOICE PCs use gateway `10.200.0.20`. It won't respond until Part 4, and that's expected.

### 5. Verify
Click **Fast Forward Time** a few times so spanning tree settles and the link lights turn green.

Run these pings. All of them should **succeed**. The first one may time out once while ARP resolves.

| From | Command | What it proves |
|---|---|---|
| ZFW-RADAR | `ping 10.100.0.60` | Fort Worth can see Amarillo radar |
| ZME-RADAR | `ping 10.100.0.60` | Memphis can see Amarillo radar |
| NOC-MON | `ping 10.100.0.13` | NOC can reach Albuquerque |
| ZFW-VOICE | `ping 10.200.0.50` | Fort Worth can talk through the El Dorado radio |
| ZAB-VOICE | `ping 10.200.0.50` | Albuquerque can talk through El Dorado |

Then check spanning tree:

```
NOC-SW# show spanning-tree vlan 200
ZME-SW# show spanning-tree vlan 200
ZME-SW# show interfaces trunk
ELD-OLD# show spanning-tree vlan 200
```

Record on the worksheet:
- Which switch is the **root bridge**? How do you know?
- On the backup links (ZFW–ZME and ZME–ZAB), which port is **blocking** (`BLK` / `Altn`)?
- What does `ELD-OLD` say when you ask for its spanning tree? Why?

### 6. Save
**File → Save As → `faa-ftl-baseline.pkt`.** You'll break this network in Part 2, so keep a clean copy.
