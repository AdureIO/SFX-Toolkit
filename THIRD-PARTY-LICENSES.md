# Third-Party Licenses

The ASFX Toolkit Apex/SOQL language server bundles the following open-source
packages. All are permissively licensed and allow redistribution (including in a
commercial/closed-source product). Their copyright notices and license texts are
retained here.

| Package | License | Used for |
|---|---|---|
| `@salesforce/soql-language-server` | BSD-3-Clause | SOQL completion candidate engine (org-aware completion) |
| `@apexdevtools/apex-parser` | BSD-3-Clause | Apex parsing (outline, member completion, diagnostics, go-to-definition) |
| `vscode-languageclient` / `vscode-languageserver` / `vscode-languageserver-textdocument` | MIT | Language Server Protocol client/server runtime |
| `antlr4` / `antlr4ts` (transitive) | BSD-3-Clause | Parser runtime used by the above |

## BSD-3-Clause

> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
> 1. Redistributions of source code must retain the above copyright notice, this
>    list of conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice,
>    this list of conditions and the following disclaimer in the documentation
>    and/or other materials provided with the distribution.
> 3. Neither the name of the copyright holder nor the names of its contributors
>    may be used to endorse or promote products derived from this software
>    without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
> ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED. IN NO EVENT SHALL THE
> COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, …

Copyright holders: Salesforce.com inc. (`@salesforce/*`), FinancialForce.com /
apex-dev-tools contributors (`@apexdevtools/*`), Terence Parr and the ANTLR
project (`antlr4`).

## MIT

> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the "Software"), to deal in
> the Software without restriction… THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
> WARRANTY OF ANY KIND.

Copyright holders: Microsoft Corporation (`vscode-language*`).

Full license texts are available in each package's directory under `node_modules`
and in their respective source repositories.
