# Migrations

`db/baseline.sql` is the complete schema up to the migration named on its
`-- baseline-cut:` line — every table, index, constraint, trigger, row-level-security
policy and grant — generated from the full internal migration history and verified
against it.

The files here are the schema changes made after the first public release. A fresh
install applies the baseline, records its cut, then applies every file newer than the
cut; an existing install applies only the files it has not recorded yet:

```sh
pnpm db:migrate        # or the Docker image's `init` service
```

The baseline is re-cut at each release and files stay here, so any version can reach
any later version.
