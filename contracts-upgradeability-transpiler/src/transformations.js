const {
  getImportDirectives,
  getPragmaDirectives,
  getVarDeclarations,
  getNodeSources,
  getSourceIndices,
  getConstructor,
  getContracts,
  getContract,
  idModifierInvocation
} = require("./ast-utils");

const { getInheritanceChain } = require("./get-inheritance-chain");

function appendDirective(fileNode, directive) {
  const retVal = {
    start: 0,
    end: 0,
    text: directive
  };
  const importsAndPragmas = [
    ...getPragmaDirectives(fileNode),
    ...getImportDirectives(fileNode)
  ];
  if (importsAndPragmas.length) {
    const last = importsAndPragmas.slice(-1)[0];
    const [start, len] = getSourceIndices(last);
    retVal.start = start + len;
    retVal.end = start + len;
  }

  return retVal;
}

function prependBaseClass(contractNode, source, cls) {
  const hasInheritance = contractNode.baseContracts.length;

  const [start, len, nodeSource] = getNodeSources(contractNode, source);

  const regExp = RegExp(`\\bcontract\\s+${contractNode.name}(\\s+is)?`);

  const match = regExp.exec(nodeSource);
  if (!match)
    throw new Error(`Can't find ${contractNode.name} in ${nodeSource}`);

  return {
    start: start + match.index + match[0].length,
    end: start + match.index + match[0].length,
    text: hasInheritance ? ` ${cls},` : ` is ${cls}`
  };
}

function transformParents(contractNode, source, contracts) {
  const hasInheritance = contractNode.baseContracts.length;

  if (hasInheritance) {
    return contractNode.baseContracts
      .filter(base =>
        contracts.some(contract => base.baseName.name === contract)
      )
      .map(base => {
        const [start, , baseSource] = getNodeSources(base.baseName, source);
        const [, len] = getNodeSources(base, source);

        return {
          start: start,
          end: start + len,
          text: `${baseSource}Upgradable`
        };
      });
  } else return [];
}

function transformContractName(contractNode, source, newName) {
  const [start, len, nodeSource] = getNodeSources(contractNode, source);

  const subStart = nodeSource.indexOf(contractNode.name);
  if (subStart === -1)
    throw new Error(`Can't find ${contractNode.name} in ${nodeSource}`);

  return {
    start: start + subStart,
    end: start + subStart + contractNode.name.length,
    text: newName
  };
}

function buildSuperCall(args, name, source) {
  let superCall = `\n${name}Upgradable.__init(false`;
  if (args && args.length) {
    superCall += args.reduce((acc, arg, i) => {
      const [, , argSource] = getNodeSources(arg, source);
      return acc + `, ${argSource}`;
    }, "");
  }
  return superCall + ");";
}

function buildSuperCalls(node, source, contracts) {
  const hasInheritance = node.baseContracts.length;
  if (hasInheritance) {
    let superCalls = [];

    const constructorNode = getConstructor(node);
    const mods = constructorNode
      ? constructorNode.modifiers.filter(mod => idModifierInvocation(mod))
      : [];

    return [
      ...superCalls,
      ...node.baseContracts
        .filter(base =>
          contracts.some(contract => base.baseName.name === contract)
        )
        .map(base => {
          const mod = mods.some(
            mod => mod.modifierName.name === base.baseName.name
          )[0];
          if (mod) {
            return buildSuperCall(mod.arguments, mod.modifierName.name, source);
          } else {
            return buildSuperCall(base.arguments, base.baseName.name, source);
          }
        })
    ];
  } else {
    return [];
  }
}

function buildSuperCallsForChain(
  contractNode,
  source,
  contracts,
  contractsToArtifactsMap
) {
  return [
    ...new Set(
      getInheritanceChain(contractNode.name, contractsToArtifactsMap)
        .map(base => {
          const calls = buildSuperCalls(
            getContract(contractsToArtifactsMap[base].ast, base),
            source,
            contracts
          );
          return calls.reverse();
        })
        .flat()
    )
  ]
    .reverse()
    .join("");
}

function getVarInits(contractNode, source) {
  const varDeclarations = getVarDeclarations(contractNode);
  return varDeclarations
    .filter(vr => vr.value && !vr.constant)
    .map(vr => {
      const [start, len, varSource] = getNodeSources(vr, source);

      const match = /(.*)(=.*)/.exec(varSource);
      if (!match) throw new Error(`Can't find = in ${varSource}`);
      return `\n${vr.name} ${match[2]};`;
    })
    .join("");
}

function purgeVarInits(contractNode, source) {
  const varDeclarations = getVarDeclarations(contractNode);
  return varDeclarations
    .filter(vr => vr.value && !vr.constant)
    .map(vr => {
      const [start, len, varSource] = getNodeSources(vr, source);
      const match = /(.*)(=.*)/.exec(varSource);
      if (!match) throw new Error(`Can't find = in ${varSource}`);
      return {
        start: start + match[1].length,
        end: start + match[1].length + match[2].length,
        text: ""
      };
    });
}

function purgeBaseConstructorCalls(constructorNode, source) {
  if (constructorNode && constructorNode.modifiers) {
    const mods = constructorNode.modifiers.filter(mod =>
      idModifierInvocation(mod)
    );
    return mods.map(mod => {
      const [start, len, modSource] = getNodeSources(mod, source);
      return {
        start,
        end: start + len,
        text: ""
      };
    });
  }
}

function transformConstructor(
  contractNode,
  source,
  contracts,
  contractsToArtifactsMap
) {
  const superCalls = buildSuperCallsForChain(
    contractNode,
    source,
    contracts,
    contractsToArtifactsMap
  );

  const declarationInserts = getVarInits(contractNode, source);

  const constructorNode = getConstructor(contractNode);
  [];

  let removeConstructor = null;
  let constructorBodySource = null;
  let constructorParameterList = null;
  let constructorArgsList = null;
  if (constructorNode) {
    constructorBodySource = getNodeSources(constructorNode.body, source)[2];

    constructorParameterList = getNodeSources(
      constructorNode.parameters,
      source
    )[2]
      .slice(1)
      .slice(0, -1);

    const [start, len] = getNodeSources(constructorNode, source);

    removeConstructor = {
      start: start,
      end: start + len,
      text: ""
    };

    constructorArgsList = constructorNode.parameters.parameters
      .map(par => par.name)
      .join(",");
  }

  constructorParameterList = constructorParameterList
    ? constructorParameterList
    : "";
  constructorBodySource = constructorBodySource ? constructorBodySource : "";
  constructorArgsList = constructorArgsList ? constructorArgsList : "";

  const [start, len, contractSource] = getNodeSources(contractNode, source);

  const match = /\bcontract[^\{]*{/.exec(contractSource);
  if (!match)
    throw new Error(`Can't find contract pattern in ${constructorSource}`);

  return [
    removeConstructor,
    {
      start: start + match[0].length,
      end: start + match[0].length,
      text: `
        function initialize(${constructorParameterList}) public initializer {
                __init(true${
                  constructorArgsList ? `, ${constructorArgsList}` : ""
                });
              }
        \nfunction __init(bool callChain${
          constructorParameterList ? `, ${constructorParameterList}` : ""
        }) internal {
          if(callChain) {${superCalls}}
          ${declarationInserts}
          ${constructorBodySource}
        }`
    }
  ].filter(tran => tran !== null);
}

function purgeContracts(astNode, contracts) {
  const toPurge = getContracts(astNode).filter(node =>
    contracts.every(c => node.name !== c)
  );
  return toPurge.map(contractNode => {
    const [start, len] = getSourceIndices(contractNode);

    return {
      start,
      end: start + len,
      text: ""
    };
  });
}

function fixImportDirectives(artifact, artifacts, contracts) {
  const imports = getImportDirectives(artifact.ast);
  return imports.map(imp => {
    const [start, len] = getSourceIndices(imp);
    const isTranspiled = artifacts.some(
      art =>
        art.ast.id === imp.sourceUnit &&
        contracts.some(contract => contract === art.contractName)
    );
    const prefix = !imp.file.startsWith(".") ? "./" : "";
    let fixedPath = `import "${prefix}${imp.file.replace(
      ".sol",
      "Upgradable.sol"
    )}";`;
    return {
      start,
      end: start + len,
      text: !isTranspiled ? `import "${imp.absolutePath}";` : fixedPath
    };
  });
}

module.exports = {
  transformConstructor,
  transformContractName,
  appendDirective,
  prependBaseClass,
  purgeContracts,
  transformParents,
  fixImportDirectives,
  purgeVarInits
};
