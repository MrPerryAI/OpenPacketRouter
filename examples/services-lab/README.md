# Syslog and NTP services

Server SRV runs two services on one address, `10.0.0.10`: a syslog receiver on UDP 514 (`service syslog`) and an NTP server on UDP 123 at stratum 2 (`service ntp 2`). Client A sends one log message, then asks SRV for the time.

```bash
node engine/bin/openpacketrouter.mjs run examples/services-lab/spec.json examples/services-lab/actions.json --text
node cli/bin/opr-cli.mjs examples/services-lab/spec.json SRV     # then: show syslog, show ntp
```

The NTP reply carries a wall-clock time, so the validators compare only stratum, request details and frame counts, not timestamps. Both services are validated against real Linux tools in `validate/services`.
