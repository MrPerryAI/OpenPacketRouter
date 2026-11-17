# Incident Briefing: The November 13, 2026 FAA Ground Stop

*Student reading. About 10 minutes. Facts are as reported through November 17, 2026, and the investigation is still open.*

## The short version

On a Friday afternoon, air traffic controllers across the United States began seeing **inconsistent radar data and problems communicating with aircraft**. At 3:54 p.m. Eastern, the FAA stopped all departures nationwide. It was only the **second nationwide ground stop since September 11, 2001**. The stop lasted until 8:15 p.m. Eastern.

The trigger wasn't a cyberattack, and it wasn't weather. It was **routine maintenance at a small remote site in El Dorado, Arkansas.**

## Timeline (Eastern Time)

| Time | Event |
|---|---|
| Weeks before | The contractor finishes similar router work at a radar site in **Amarillo, Texas**, with no reported problems. |
| Nov 13, afternoon | Technicians at the **El Dorado, AR** radio site move it from **copper to fiber** and replace an **older Cisco router with a new Juniper router**. |
| 3:36 p.m. | Controllers begin seeing **radar and communications inconsistencies**. |
| 3:54 p.m. | The FAA issues a **nationwide ground stop**. |
| Evening | The network operator **blocks traffic from the Arkansas and Texas sites**, and the network stabilizes. |
| 8:15 p.m. | The ground stop is lifted. Cancellations continue through the weekend. |
| Following days | The FAA **disables the "broadcast function"** on the newly installed routers as a precaution. Both routers go to a lab in Florida for examination. |

## What we know

- **The network:** The FAA Telecommunications Infrastructure (**FTI**) network connects radar sites, radio sites, and air traffic control facilities. The contractor **L3Harris** owns and operates it for the FAA.
- **The scope:** Instability hit **17 of the FAA's 22 en route air traffic control centers** (called ARTCCs, or "Centers").
- **The mechanism, in general terms:** The FAA said its "legacy equipment became unstable when data began **flooding** the FAA FTI network." Reports describe about **1,000 connection attempts every 4 to 5 seconds**.
- **Two sites were involved.** A router in **Amarillo, Texas**, more than 500 miles away, also began flooding the network **when the new El Dorado router was switched on**, even though the Amarillo work had been finished weeks earlier.
- **The router maker's position:** HPE, which owns Juniper, said the device "functioned as it was configured to by the installer. It did not fail or act improperly."
- **Not a cyberattack:** Officials said they found no evidence of one.
- **Impact:** About **12,462 flights** were canceled on November 13. About 6,700 were canceled Saturday, about 2,300 on Sunday, and 373 on Monday.

## What we *don't* know yet

- Which protocol or traffic type made up the flood.
- Whether the root cause was the **configuration**, the **hardware**, or the **installation process**.
- Why a router in Texas reacted to a change in Arkansas.
- Why existing safeguards didn't stop the flood before it spread.

Keep these open questions in mind. In the lab, you'll build a **simplified model** of this kind of failure: a **broadcast storm** in a shared network. It isn't a claim about exactly what happened. It shows how a change at one tiny site can ripple across a whole country, and how engineers design networks so it can't.

## Big ideas to watch for

1. **Failure domain:** If many sites share one network segment, one bad device can hurt all of them.
2. **Latent conditions:** Settings that are harmless on their own, like "this site only has one link, so we turned off loop protection," can become dangerous when something else changes.
3. **"Working as configured" can still mean broken.** A device that perfectly follows a bad configuration is still the problem.
4. **Change management:** Routine work needs a written plan, a rollback plan, and checks at every step.

## Sources

- FAA, [Nationwide Ground Stop: Questions and Answers](https://www.faa.gov/newsroom/nationwide-ground-stop-questions-and-answers)
- AeroTime, [FAA investigates Arkansas router upgrade after US ground stop](https://www.aerotime.aero/articles/faa-arkansas-router-upgrade-us-ground-stop)
- NPR, [FAA blames Friday's ground stop on 'equipment issue' during telecoms network upgrade](https://www.npr.org/2026/11/14/nx-s1-6040952/faa-ground-stop-airplane-travel)
- The Hill, [FAA identifies Arkansas router as cause of nationwide FAA ground stop](https://thehill.com/policy/technology/6222677-faa-ground-stop-router/)
- CNBC, [FAA lifts ground stop after more than four hours](https://www.cnbc.com/2026/11/13/faa-ground-stop.html)
- NBC News, [Thousands of flights canceled or delayed Saturday after FAA's nationwide ground stop](https://www.nbcnews.com/news/us-news/faa-orders-nationwide-ground-stop-departing-flights-reasons-safety-rcna609247)
- Shattered.io, [FAA Ground Stop: HPE Says Juniper Router Worked Fine](https://shattered.io/faa-ground-stop-hpe-juniper-router-did-not-fail-69-routers-disabled/)
- Wikipedia, [2026 FAA communication outage](https://en.wikipedia.org/wiki/2026_FAA_communication_outage)

*Teachers: before class, check the sources for updates. Findings may have been released since this was written.*
