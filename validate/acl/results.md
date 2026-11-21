| Network | Action | Engine result (same in Linux?) | Frames (engine = Linux, cable by cable?) | Match |
|---|---|---|---|---|
| acl-lab | ping A → 10.2.0.10 | ok from 10.2.0.10 | 8 frames on 4 cable directions | ✓ |
| acl-lab | dns A → 10.2.0.10 (srv.lab) | ok from 10.2.0.10 | 8 frames on 4 cable directions | ✓ |
| acl-lab | udp A → 10.2.0.10 port 8000 | timeout | 7 frames on 4 cable directions | ✓ |
| acl-lab | udp A → 10.2.0.10 port 9000 | administratively prohibited from 10.1.0.1 | 4 frames on 2 cable directions | ✓ |
| acl-lab | udp A → 10.2.0.10 port 5000 | administratively prohibited from 10.1.0.1 | 4 frames on 2 cable directions | ✓ |
| acl-lab | ping A → 10.1.0.1 | administratively prohibited from 10.1.0.1 | 4 frames on 2 cable directions | ✓ |
| acl-lab | ping A → 10.2.0.99 | timeout | 6 frames on 3 cable directions | ✓ |
| acl-lab | ping S → 10.1.0.10 | administratively prohibited from 10.2.0.1 | 4 frames on 2 cable directions | ✓ |
| acl-lab | traceroute A → 10.2.0.10 | reached · 10.1.0.1 → 10.2.0.10 | 10 frames on 4 cable directions | ✓ |
| acl-lab | tcp A → 10.2.0.10 port 80 | ok from 10.2.0.10 | 24 frames on 4 cable directions | ✓ |
| acl-lab | tcp A → 10.2.0.10 port 7 | os error 113 | 4 frames on 2 cable directions | ✓ |
| acl-lab | tcp A → 10.2.0.10 port 8080 | os error 113 | 4 frames on 2 cable directions | ✓ |
