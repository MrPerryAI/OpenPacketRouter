# Part 5: Write the Plan That Should Have Existed

**Goal:** Write a professional **Method of Procedure (MOP)** for the El Dorado cutover. It should catch the mistake *before* it reaches the network.
**Time:** About 30 to 45 minutes. Work in groups of 2 or 3.
**No Packet Tracer needed.** You can still use it to test your plan.

## Why this matters

Look at the work order from Part 2 again. It says **"Rollback plan: N/A - routine."** Most big outages don't start with something exotic. They start with routine work done under normal assumptions. Engineering teams use MOPs and change reviews to make routine work safe.

## Your task

Rewrite work order #FTI-ELD-0413 as a MOP using the template below. A good MOP lets a technician who has **never seen this site** do the work safely, and **stop** safely if something goes wrong.

```
METHOD OF PROCEDURE - El Dorado copper-to-fiber cutover
=======================================================
1. SUMMARY
   What is changing, why, and what could break.

2. RISK ASSESSMENT
   - What services ride this site?          (VLANs, systems, users)
   - What is the blast radius if it fails?  (which Centers?)
   - Risk level: Low / Medium / High - and why.

3. SCHEDULE & COMMUNICATIONS
   - Maintenance window (day/time) and why you chose it.
   - Who must be notified before, during, and after? (NOC, Centers...)

4. PRE-CHECKS  (stop if any fail)
   - Config peer review: which line(s) in the template must change?
   - Baseline captures: what will you record BEFORE starting?
     (e.g., show spanning-tree, ping tests, interface counters)

5. PROCEDURE  (one action per step, with a VERIFY after each)
   Step | Action | Verify | Expected result | If not expected -> 
   -----+--------+--------+-----------------+------------------

6. ROLLBACK PLAN
   - Exact commands/cable moves to return to the starting state.
   - Rollback TRIGGERS: what observations make you stop immediately?
   - How long does rollback take?

7. POST-CHECKS
   - Tests that prove every Center is healthy.

8. FLEET FOLLOW-UP
   - The same template is already at Amarillo. What do you do about it?
   - The template will go to dozens more sites. How do you roll it out
     safely? (Hint: look up "canary deployment.")
```

## Requirements checklist

- [ ] The peer review names the dangerous template lines and gives the fix.
- [ ] Each procedure step changes **one** thing and has a verify step.
- [ ] There is a rule like "never have both uplinks and the cross-connect live until STP shows a blocked port."
- [ ] At least **three** concrete rollback triggers, such as an Event List flood, a ping failure from a Center, or high interface counters.
- [ ] Rollback steps are written out as actual commands.
- [ ] The communications plan includes the **Centers**, not just the NOC.
- [ ] The fleet plan covers Amarillo and future sites.

## Test it (optional but powerful)

Swap MOPs with another group. Starting from `faa-ftl-baseline.pkt`, follow **their** MOP exactly as written, nothing more. Did it prevent the storm? Did you have to guess at any step? Give them written feedback.
